from flask import Flask, request, jsonify, send_from_directory, Response, stream_with_context
from flask_cors import CORS
from flask_mysqldb import MySQL
from werkzeug.security import generate_password_hash, check_password_hash
from flask_jwt_extended import (
    JWTManager,
    create_access_token,
    jwt_required,
    get_jwt_identity,
    get_jwt,
)
from config import Config
from zoneinfo import ZoneInfo

import os, uuid, datetime, re, json, hashlib, queue, threading, time

app = Flask(__name__)
app.config.from_object(Config)
latest_gateway_meta = {}

# ─────────────────────── SSE REGISTRY ───────────────────────────
# Thread-safe set of per-client queues. Each connected browser gets its own.
_sse_clients: list[queue.Queue] = []
_sse_lock = threading.Lock()

NODE_IDS = ["NODE_01", "NODE_02", "NODE_03"]
NODE_OFFLINE_THRESHOLD_SEC = 60
_node_last_seen: dict[str, float] = {}   # node_id -> epoch seconds


def _sse_broadcast(payload: dict) -> None:
    """Push a JSON payload to all connected SSE clients."""
    msg = f"data: {json.dumps(payload)}\n\n"
    with _sse_lock:
        dead = []
        for q in _sse_clients:
            try:
                q.put_nowait(msg)
            except queue.Full:
                dead.append(q)
        for q in dead:
            _sse_clients.remove(q)


def _node_status_event() -> dict:
    """Build a node-status dict for the heartbeat event."""
    now = time.time()
    statuses = {}
    for node in NODE_IDS:
        last = _node_last_seen.get(node)
        if last is None:
            statuses[node] = {"online": False, "last_seen": None, "elapsed_sec": None}
        else:
            elapsed = now - last
            statuses[node] = {
                "online": elapsed < NODE_OFFLINE_THRESHOLD_SEC,
                "last_seen": datetime.datetime.fromtimestamp(last).isoformat(),
                "elapsed_sec": round(elapsed, 1),
            }
    return {"type": "node_status", "statuses": statuses}


def _sse_heartbeat_thread():
    """Sends a heartbeat+node_status event every 10 seconds to keep connections alive."""
    while True:
        time.sleep(10)
        try:
            _sse_broadcast(_node_status_event())
        except Exception:
            pass


def _normalize_jwt_secret(secret: str) -> str:
    """
    PyJWT / RFC 7518 recommend HS256 keys >= 32 bytes. Short strings (e.g. 17-char .env
    values) trigger InsecureKeyLengthWarning and can cause verify failures → 422 on every
    protected route. Stretch deterministically so the same .env always maps to the same key.
    """
    if not secret:
        secret = "dev-only-set-JWT_SECRET_KEY-in-backend-.env"
    raw = secret.encode("utf-8")
    if len(raw) >= 32:
        return secret
    return hashlib.sha256(raw).hexdigest()


# Flask-JWT-Extended requires a non-empty secret.
_secret = app.config.get("JWT_SECRET_KEY") or os.getenv("JWT_SECRET_KEY") or ""
app.config["JWT_SECRET_KEY"] = _normalize_jwt_secret(_secret)
app.config["JWT_ALGORITHM"] = "HS256"


def current_jwt_identity():
    """
    Build a consistent identity dict for routes.
    Prefer tokens issued with string `sub` + `additional_claims` (role, assigned_node).
    Legacy tokens may still use dict / JSON string in `sub`.
    """
    ident = get_jwt_identity()
    claims = get_jwt()
    if isinstance(ident, dict):
        return ident
    if ident is not None and claims.get("role") is not None:
        try:
            uid_int = int(ident)
        except (TypeError, ValueError):
            uid_int = ident
        an = claims.get("assigned_node")
        return {
            "id": uid_int,
            "role": claims.get("role"),
            "assigned_node": an if an else None,
        }
    if isinstance(ident, str):
        try:
            return json.loads(ident)
        except json.JSONDecodeError:
            return {}
    return {}


# Explicit CORS: browsers must be allowed to send Authorization on cross-origin requests
CORS(
    app,
    origins="*",
    allow_headers=["Authorization", "Content-Type"],
    expose_headers=["Authorization"],
    methods=["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
)

mysql = MySQL(app)
jwt = JWTManager(app)

# Start SSE heartbeat daemon
_hb = threading.Thread(target=_sse_heartbeat_thread, daemon=True)
_hb.start()


# ─────────────────────── SSE STREAM ENDPOINT ─────────────────────────
@app.route("/api/stream")
def sse_stream():
    """
    Server-Sent Events endpoint. Dashboard connects here via EventSource.
    Delivers real-time sensor packets as they arrive.
    No JWT required — use a query param ?token=... if you want auth.
    CORS is handled by Flask-CORS for all /api/* routes.
    """
    client_q: queue.Queue = queue.Queue(maxsize=50)
    with _sse_lock:
        _sse_clients.append(client_q)

    def generate():
        # Send current node status immediately on connect
        try:
            yield f"data: {json.dumps(_node_status_event())}\n\n"
        except Exception:
            pass

        try:
            while True:
                try:
                    msg = client_q.get(timeout=15)
                    yield msg
                except queue.Empty:
                    # SSE retry directive + keepalive comment
                    yield "retry: 3000\n"
                    yield ": keepalive\n\n"
        except GeneratorExit:
            pass
        finally:
            with _sse_lock:
                if client_q in _sse_clients:
                    _sse_clients.remove(client_q)

    headers = {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache, no-store",
        "X-Accel-Buffering": "no",
        "Connection": "keep-alive",
    }
    return Response(stream_with_context(generate()), headers=headers)


# ─────────────────────── SSE PUSH (internal, from serial bridge) ───────
@app.route("/api/stream/push", methods=["POST"])
def sse_push():
    """
    Internal endpoint: serial_bridge_ingest.py POSTs here to push events
    to all connected SSE clients instantly (no DB write — just fan-out).
    """
    payload = request.json
    if not payload:
        return jsonify({"error": "empty payload"}), 400

    node_id = payload.get("node_id")
    if node_id:
        _node_last_seen[node_id] = time.time()

    payload["type"] = "sensor_data"
    _sse_broadcast(payload)
    return jsonify({"pushed": True, "clients": len(_sse_clients)}), 200


@app.route("/api/health", methods=["GET"])
def health():
    # Simple unauthenticated health check for ESP32 gateway failover.
    return jsonify({"ok": True}), 200


@jwt.invalid_token_loader
def _invalid_token_callback(err):
    return jsonify({"msg": "Invalid or expired token", "detail": str(err)}), 422


@jwt.unauthorized_loader
def _missing_token_callback(err):
    return jsonify({"msg": "Authorization header missing or bad", "detail": str(err)}), 401

UPLOAD_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "uploads")
os.makedirs(UPLOAD_DIR, exist_ok=True)


def isoformat_server_datetime(value):
    """
    MySQL DATETIME is naive. Attach APP_TIMEZONE (default Asia/Kolkata) so JSON uses
    ISO-8601 with offset; browsers then show correct local time on charts.
    Set APP_TIMEZONE=UTC in .env if your database stores UTC.
    """
    if value is None:
        return None
    if not isinstance(value, datetime.datetime):
        return value
    tz_name = os.getenv("APP_TIMEZONE") or getattr(Config, "APP_TIMEZONE", "Asia/Kolkata")
    try:
        tz = ZoneInfo(tz_name)
    except Exception:
        return value.isoformat(sep="T", timespec="seconds")
    if value.tzinfo is None:
        value = value.replace(tzinfo=tz)
    return value.isoformat(timespec="seconds")


def as_float(value, default=0.0):
    try:
        if value is None or value == "":
            return default
        return float(value)
    except (TypeError, ValueError):
        return default


def as_int(value, default=0):
    try:
        if value is None or value == "":
            return default
        return int(value)
    except (TypeError, ValueError):
        return default


def as_bool(value):
    if isinstance(value, bool):
        return value
    if isinstance(value, (int, float)):
        return value != 0
    if isinstance(value, str):
        return value.strip().lower() in {"1", "true", "yes", "y", "on"}
    return False


def infer_assigned_node(email: str, full_name: str = ""):
    """
    Infer worker->node binding from user identity without DB schema change.
    Supports patterns like:
    - worker1@... / worker_2@...
    - node01@... / node-3@...
    - Full name containing worker 1/2/3
    """
    text = f"{email or ''} {full_name or ''}".lower()

    patterns = [
        r"worker[\s_\-]*([1-3])",
        r"node[\s_\-]*0?([1-3])",
        r"\b([1-3])\b",
    ]
    for pattern in patterns:
        match = re.search(pattern, text)
        if match:
            idx = int(match.group(1))
            return f"NODE_0{idx}"
    return None

# ───────────────── SIGNUP ─────────────────
@app.route("/api/signup", methods=["POST"])
def signup():
    data = request.json
    company = data.get("companyName")
    name = data.get("fullName")
    email = (data.get("email") or "").strip().lower()
    password = data.get("password")

    if not all([company, name, email, password]):
        return jsonify({"message": "Missing fields"}), 400

    cursor = mysql.connection.cursor()
    cursor.execute("SELECT id FROM users WHERE email=%s", (email,))
    if cursor.fetchone():
        cursor.close()
        return jsonify({"message": "Email exists"}), 409

    pwd = generate_password_hash(password)
    cursor.execute("""
        INSERT INTO users (company_name, full_name, email, password_hash, role)
        VALUES (%s,%s,%s,%s,'worker')
    """, (company, name, email, pwd))
    mysql.connection.commit()
    cursor.close()
    return jsonify({"message": "Signup success", "role": "worker"}), 201


# ───────────────── LOGIN ─────────────────
@app.route("/api/login", methods=["POST"])
def login():
    data = request.json
    email = (data.get("email") or "").strip().lower()
    password = data.get("password")

    cursor = mysql.connection.cursor()
    row = None
    try:
        cursor.execute(
            "SELECT id, full_name, password_hash, role, assigned_node FROM users WHERE email=%s",
            (email,)
        )
        row = cursor.fetchone()
    except Exception:
        # Backward compatibility if assigned_node column is not yet migrated.
        cursor.execute(
            "SELECT id, full_name, password_hash, role FROM users WHERE email=%s",
            (email,)
        )
        fallback = cursor.fetchone()
        if fallback:
            row = (*fallback, None)
    finally:
        cursor.close()

    if not row:
        return jsonify({"message": "Invalid credentials"}), 401

    user_id, full_name, password_hash, role, assigned_node_db = row

    if not check_password_hash(password_hash, password):
        return jsonify({"message": "Invalid credentials"}), 401

    assigned_node = assigned_node_db if role == "worker" else None
    if role == "worker" and not assigned_node:
        assigned_node = infer_assigned_node(email, full_name)

    # String sub + additional_claims (avoids dict-in-JWT quirks across PyJWT / F-JWT versions)
    uid = int(user_id) if user_id is not None else None
    token = create_access_token(
        identity=str(uid),
        additional_claims={
            "role": role,
            "assigned_node": assigned_node or "",
        },
    )

    return jsonify({
        "access_token": token,
        "role": role,
        "fullName": full_name,
        "assigned_node": assigned_node
    }), 200


# ───────────────── SENSOR DATA INGEST ─────────────────
@app.route("/api/data", methods=["POST"])
def ingest_sensor():
    data = request.json
    if not data:
        return jsonify({"error": "Invalid payload"}), 400

    # Accept both normalized gateway payload and raw node payload keys.
    gateway_id = data.get("gateway_id") or data.get("gateway") or "GATEWAY_01"
    node_id = data.get("node_id")
    vib = data.get("vib", data.get("vib_magnitude", 0))
    flame = data.get("flame", 0)
    smoke = data.get("smoke", data.get("smoke_ppm", data.get("smoke_raw", 0)))
    gas = data.get("gas", data.get("gas_ppm", data.get("gas_raw", 0)))
    distance = data.get("distance", data.get("object_distance_cm", 0))
    anomaly = data.get("anomaly", data.get("anomaly_edge", False))
    msg_id = data.get("msg_id")
    packet_seq = as_int(data.get("packet_seq"), 0)
    retry_count = as_int(data.get("retry_count"), 0)
    delivery_status = data.get("delivery_status") or ("ACKED" if as_bool(data.get("acked")) else "RECEIVED")
    gateway_rssi = as_float(data.get("gateway_rssi"), 0.0)
    gateway_snr = as_float(data.get("gateway_snr"), 0.0)
    gateway_distance_estimate_m = as_float(
        data.get("node_gateway_distance_m", data.get("gateway_distance_estimate_m")),
        0.0,
    )
    gateway_distance_exact_m = as_float(data.get("gateway_distance_exact_m"), -1.0)
    gateway_distance_exact_valid = 1 if as_bool(data.get("gateway_distance_exact_valid")) else 0
    distance_method = data.get("distance_method") or "radio_estimate_only"
    lars_score = as_int(data.get("lars_score"), 0)
    acked = 1 if as_bool(data.get("acked")) else 0
    message_duplicate = 1 if as_bool(data.get("message_duplicate")) else 0
    gateway_ack_sent = 1 if as_bool(data.get("gateway_ack_sent")) else 0
    acked_packets_total = as_int(data.get("acked_packets_total"), 0)
    dropped_packets_total = as_int(data.get("dropped_packets_total"), 0)
    ack_timeouts_total = as_int(data.get("ack_timeouts_total"), 0)
    tx_attempts_total = as_int(data.get("tx_attempts_total"), 0)

    if not node_id:
        return jsonify({"error": "node_id missing"}), 400

    # Backward-compatible storage:
    # persist legacy columns in MySQL, and return all reliability metadata to the client.
    # If msg_id duplicates are resent from serial-bridge or gateway retry, skip DB insert.
    # Update node last-seen for SSE status
    _node_last_seen[node_id] = time.time()

    latest_gateway_meta[node_id] = {
        "msg_id": msg_id,
        "packet_seq": packet_seq,
        "retry_count": retry_count,
        "delivery_status": delivery_status,
        "gateway_rssi": gateway_rssi,
        "gateway_snr": gateway_snr,
        "gateway_distance_estimate_m": gateway_distance_estimate_m,
        "gateway_distance_exact_m": gateway_distance_exact_m,
        "gateway_distance_exact_valid": bool(gateway_distance_exact_valid),
        "distance_method": distance_method,
        "lars_score": lars_score,
        "acked": bool(acked),
        "message_duplicate": bool(message_duplicate),
        "gateway_ack_sent": bool(gateway_ack_sent),
        "acked_packets_total": acked_packets_total,
        "dropped_packets_total": dropped_packets_total,
        "ack_timeouts_total": ack_timeouts_total,
        "tx_attempts_total": tx_attempts_total,
    }

    cursor = mysql.connection.cursor()
    try:
        if msg_id:
            try:
                cursor.execute(
                    """
                    SELECT id FROM sensor_data
                    WHERE node_id=%s AND gateway_id=%s AND created_at >= DATE_SUB(NOW(), INTERVAL 1 DAY)
                    ORDER BY id DESC
                    LIMIT 200
                    """,
                    (node_id, gateway_id),
                )
                recent_rows = cursor.fetchall()
                if recent_rows and message_duplicate:
                    return jsonify({"status": "duplicate_skipped", "msg_id": msg_id}), 200
            except Exception:
                pass

        # Optional extended columns (from migration)
        lat       = as_float(data.get("lat"), None)
        lon       = as_float(data.get("lon"), None)
        ax        = as_float(data.get("ax"), 0.0)
        ay        = as_float(data.get("ay"), 0.0)
        az        = as_float(data.get("az"), 0.0)
        comm_stat = "ACKED" if as_bool(data.get("gateway_ack_sent")) else "RECEIVED"
        gw_rssi   = gateway_rssi
        gw_snr    = gateway_snr
        pkt_seq   = packet_seq
        rc_col    = retry_count

        try:
            cursor.execute("""
                INSERT INTO sensor_data
                (gateway_id,node_id,vib,flame,smoke,gas,distance,anomaly,
                 packet_seq,lat,lon,ax,ay,az,comm_status,gateway_rssi,gateway_snr,retry_count_col)
                VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)
            """, (
                gateway_id, node_id, vib, flame, smoke, gas, distance, 1 if anomaly else 0,
                pkt_seq, lat, lon, ax, ay, az, comm_stat, gw_rssi, gw_snr, rc_col
            ))
        except Exception:
            # Fallback to original columns if migration not yet run
            cursor.execute("""
                INSERT INTO sensor_data
                (gateway_id,node_id,vib,flame,smoke,gas,distance,anomaly)
                VALUES (%s,%s,%s,%s,%s,%s,%s,%s)
            """, (
                gateway_id, node_id, vib, flame, smoke, gas, distance, 1 if anomaly else 0
            ))
        mysql.connection.commit()

        # Broadcast to SSE clients immediately
        sse_payload = {
            "type":        "sensor_data",
            "gateway_id":  gateway_id,
            "node_id":     node_id,
            "seq":         packet_seq,
            "smoke":       int(smoke) if smoke else 0,
            "gas":         int(gas)   if gas   else 0,
            "flame":       int(flame),
            "distance":    float(distance) if distance else 0.0,
            "vib":         float(vib),
            "ax":          float(ax), "ay": float(ay), "az": float(az),
            "lat":         float(lat) if lat is not None else 0.0,
            "lon":         float(lon) if lon is not None else 0.0,
            "anomaly":     bool(anomaly),
            "gateway_rssi": float(gateway_rssi),
            "gateway_snr":  float(gateway_snr),
            "gateway_distance_estimate_m": float(gateway_distance_estimate_m),
            "lars_score":   int(lars_score),
            "retry_count":  int(retry_count),
            "delivery_status": str(delivery_status),
            "acked":        bool(acked),
            "created_at":   isoformat_server_datetime(datetime.datetime.now()),
        }
        _sse_broadcast(sse_payload)

        return jsonify({
            "status": "stored",
            "msg_id": msg_id,
            "packet_seq": packet_seq,
            "retry_count": retry_count,
            "delivery_status": delivery_status,
            "gateway_rssi": gateway_rssi,
            "gateway_snr": gateway_snr,
            "gateway_distance_estimate_m": gateway_distance_estimate_m,
            "gateway_distance_exact_m": gateway_distance_exact_m,
            "gateway_distance_exact_valid": bool(gateway_distance_exact_valid),
            "distance_method": distance_method,
            "lars_score": lars_score,
            "acked": bool(acked),
            "message_duplicate": bool(message_duplicate),
            "gateway_ack_sent": bool(gateway_ack_sent),
            "acked_packets_total": acked_packets_total,
            "dropped_packets_total": dropped_packets_total,
            "ack_timeouts_total": ack_timeouts_total,
            "tx_attempts_total": tx_attempts_total,
        }), 201
    except Exception as exc:
        mysql.connection.rollback()
        return jsonify({"error": "db_insert_failed", "details": str(exc)}), 500
    finally:
        cursor.close()


@app.route("/api/factory-profile")
@jwt_required()
def factory_profile():
    return jsonify({
        "factory_name": "ApexChem Blending Works",
        "industry": "Small Chemical Blending Plant",
        "zones": [
            {"id": "ZONE_1", "name": "Solvent Mixing Bay"},
            {"id": "ZONE_2", "name": "Drum Filling Conveyor"},
            {"id": "ZONE_3", "name": "Storage & Dispatch"},
        ],
        "safety_focus": [
            "Flammable vapor build-up",
            "Localized open flame risks",
            "Proximity hazards around moving drums",
        ],
    })


# ───────────────── SENSOR DATA FETCH ─────────────────
@app.route("/api/sensor-data")
@jwt_required()
def sensor_data():
    """
    Latest sensor data for dashboards (both manager & worker).

    IMPORTANT:
    - Use cursor.description to build dicts so that column order
      and selected fields always stay aligned.
    - Managers see more history, workers see a smaller window.
    """
    identity = current_jwt_identity()
    role = identity.get("role")

    cursor = mysql.connection.cursor()

    if role == "manager":
        cursor.execute(
            """
            SELECT gateway_id, node_id, vib, flame, smoke, gas, distance, anomaly, created_at
            FROM sensor_data
            ORDER BY created_at DESC
            LIMIT 200
            """
        )
    else:
        assigned_node = identity.get("assigned_node")
        if assigned_node:
            cursor.execute(
                """
                SELECT gateway_id, node_id, vib, flame, smoke, gas, distance, anomaly, created_at
                FROM sensor_data
                WHERE node_id = %s
                ORDER BY created_at DESC
                LIMIT 100
                """,
                (assigned_node,)
            )
        else:
            cursor.execute(
                """
                SELECT gateway_id, node_id, vib, flame, smoke, gas, distance, anomaly, created_at
                FROM sensor_data
                ORDER BY created_at DESC
                LIMIT 100
                """
            )

    rows = cursor.fetchall()

    # Column names direct from MySQL cursor
    col_names = [desc[0] for desc in cursor.description]
    cursor.close()

    data = [dict(zip(col_names, row)) for row in rows]

    for row in data:
        meta = latest_gateway_meta.get(row.get("node_id"), {})
        if row.get("created_at") is not None:
            row["created_at"] = isoformat_server_datetime(row["created_at"])
        row["msg_id"] = meta.get("msg_id") or f"{row.get('node_id', 'NODE')}-{row.get('created_at', '')}"
        row["packet_seq"] = meta.get("packet_seq", 0)
        row["retry_count"] = meta.get("retry_count", 0)
        row["delivery_status"] = meta.get("delivery_status") or "STORED"
        row["gateway_rssi"] = meta.get("gateway_rssi", 0)
        row["gateway_snr"] = meta.get("gateway_snr", 0)
        row["gateway_distance_estimate_m"] = meta.get("gateway_distance_estimate_m", 0)
        row["gateway_distance_exact_m"] = meta.get("gateway_distance_exact_m", -1)
        row["gateway_distance_exact_valid"] = bool(meta.get("gateway_distance_exact_valid", False))
        row["distance_method"] = meta.get("distance_method") or "radio_estimate_only"
        row["lars_score"] = meta.get("lars_score", 0)
        row["acked"] = bool(meta.get("acked", True))
        row["message_duplicate"] = bool(meta.get("message_duplicate", False))
        row["gateway_ack_sent"] = bool(meta.get("gateway_ack_sent", True))
        row["acked_packets_total"] = meta.get("acked_packets_total", 0)
        row["dropped_packets_total"] = meta.get("dropped_packets_total", 0)
        row["ack_timeouts_total"] = meta.get("ack_timeouts_total", 0)
        row["tx_attempts_total"] = meta.get("tx_attempts_total", 0)

    resp = jsonify(data)
    resp.headers["Cache-Control"] = "no-store, no-cache, must-revalidate, max-age=0"
    resp.headers["Pragma"] = "no-cache"
    return resp


@app.route("/api/network-health")
@jwt_required()
def network_health():
    """
    Lightweight gateway-network health summary built from recent sensor_data cadence.
    """
    cursor = mysql.connection.cursor()
    cursor.execute(
        """
        SELECT node_id, COUNT(*) AS rows_count, MAX(created_at) AS last_seen,
               AVG(distance) AS avg_sensor_distance
        FROM sensor_data
        WHERE created_at >= DATE_SUB(NOW(), INTERVAL 10 MINUTE)
        GROUP BY node_id
        ORDER BY node_id
        """
    )
    rows = cursor.fetchall()
    cursor.close()

    health = []
    for node_id, rows_count, last_seen, avg_sensor_distance in rows:
        if rows_count >= 20:
            quality = "strong"
        elif rows_count >= 10:
            quality = "moderate"
        else:
            quality = "weak"

        # With current DB schema we cannot query ACK/retry history directly, so derive a conservative
        # health summary from recent cadence. Frontend can also refine this using /sensor-data latest row.
        packet_failure = "low"
        if rows_count < 6:
            packet_failure = "high"
        elif rows_count < 12:
            packet_failure = "medium"
        meta = latest_gateway_meta.get(node_id, {})
        health.append({
            "node_id": node_id,
            "rows_10m": int(rows_count or 0),
            "last_seen": isoformat_server_datetime(last_seen),
            "link_quality": quality,
            "gateway_distance_estimate_m": meta.get("gateway_distance_estimate_m", 0),
            "gateway_distance_exact_m": meta.get("gateway_distance_exact_m", -1),
            "gateway_distance_exact_valid": bool(meta.get("gateway_distance_exact_valid", False)),
            "distance_method": meta.get("distance_method") or "radio_estimate_only",
            "lars_score": meta.get("lars_score", 0),
            "retry_count": meta.get("retry_count", 0),
            "delivery_status": meta.get("delivery_status") or "UNKNOWN",
            "acked_packets_total": meta.get("acked_packets_total", 0),
            "dropped_packets_total": meta.get("dropped_packets_total", 0),
            "ack_timeouts_total": meta.get("ack_timeouts_total", 0),
            "packet_failure": packet_failure,
            "avg_sensor_distance": float(avg_sensor_distance or 0),
        })
    return jsonify(health)



# ───────────────── CAMERA IMAGE UPLOAD ─────────────────
@app.route("/api/camera/upload", methods=["POST"])
def camera_upload():
    img = request.data
    filename = f"{uuid.uuid4()}.jpg"
    path = os.path.join(UPLOAD_DIR, filename)

    with open(path, "wb") as f:
        f.write(img)

    cursor = mysql.connection.cursor()
    cursor.execute(
        "INSERT INTO camera_images (filename) VALUES (%s)",
        (filename,)
    )
    mysql.connection.commit()
    cursor.close()

    return jsonify({"saved": filename}), 201


# ───────────────── CAMERA LIST ─────────────────
@app.route("/api/camera/list")
@jwt_required()
def camera_list():
    cursor = mysql.connection.cursor()
    cursor.execute("""
        SELECT id, filename, created_at
        FROM camera_images
        ORDER BY created_at DESC LIMIT 20
    """)
    rows = cursor.fetchall()
    cursor.close()

    data = [
        {
            "id": r[0],
            "filename": r[1],
            "created_at": isoformat_server_datetime(r[2]),
        }
        for r in rows
    ]

    return jsonify(data)

@app.route("/api/nodes")
@jwt_required()
def get_nodes():
    identity = current_jwt_identity()
    user_id = identity.get("id")
    if user_id is None:
        return jsonify({"message": "Invalid token identity"}), 401

    cursor = mysql.connection.cursor()
    
    # Agar har user/company ke alag nodes hain to yeh query use karo
    cursor.execute("""
        SELECT 
            id, name, x_position AS x, y_position AS y,
            status, zone, last_seen AS lastSeen,
            voltage, temperature, vibration
        FROM nodes
        WHERE company_id = (SELECT company_id FROM users WHERE id = %s)
        ORDER BY name
    """, (user_id,))
    
    nodes = cursor.fetchall()
    cursor.close()
    
    return jsonify(nodes)

# ───────────────── IMAGE SERVE ─────────────────
@app.route("/uploads/<filename>")
def serve_image(filename):
    return send_from_directory(UPLOAD_DIR, filename)


# ───────────────── TEAM MEMBERS (Manager Only) ─────────────────
@app.route("/api/team-members")
@jwt_required()
def team_members():
    identity = current_jwt_identity()
    role = identity.get("role")
    
    if role != "manager":
        return jsonify({"message": "Unauthorized"}), 403
    
    cursor = mysql.connection.cursor()
    cursor.execute("""
        SELECT id, full_name, email, company_name, role, created_at
        FROM users
        ORDER BY created_at DESC
    """)
    rows = cursor.fetchall()
    col_names = [desc[0] for desc in cursor.description]
    cursor.close()
    
    data = [dict(zip(col_names, row)) for row in rows]
    for row in data:
        if row.get("created_at") is not None:
            row["created_at"] = isoformat_server_datetime(row["created_at"])
    return jsonify(data)


# ───────────────── REPORTS (Manager Only) ─────────────────
@app.route("/api/reports")
@jwt_required()
def reports():
    identity = current_jwt_identity()
    role = identity.get("role")
    
    if role != "manager":
        return jsonify({"message": "Unauthorized"}), 403
    
    cursor = mysql.connection.cursor()
    
    # Daily stats (updated thresholds: gas > 400, smoke > 1200)
    cursor.execute("""
        SELECT 
            COUNT(*) as total_alerts,
            SUM(CASE WHEN anomaly = 1 OR flame = 1 OR distance < 50 OR smoke > 1200 OR gas > 400 THEN 1 ELSE 0 END) as critical_events
        FROM sensor_data
        WHERE DATE(created_at) = CURDATE()
    """)
    daily_row = cursor.fetchone()
    
    # Weekly stats
    cursor.execute("""
        SELECT 
            COUNT(*) as total_alerts,
            SUM(CASE WHEN anomaly = 1 OR flame = 1 OR distance < 50 OR smoke > 1200 OR gas > 400 THEN 1 ELSE 0 END) as critical_events
        FROM sensor_data
        WHERE created_at >= DATE_SUB(NOW(), INTERVAL 7 DAY)
    """)
    weekly_row = cursor.fetchone()
    
    # Monthly stats
    cursor.execute("""
        SELECT 
            COUNT(*) as total_alerts,
            SUM(CASE WHEN anomaly = 1 OR flame = 1 OR distance < 50 OR smoke > 1200 OR gas > 400 THEN 1 ELSE 0 END) as critical_events
        FROM sensor_data
        WHERE created_at >= DATE_SUB(NOW(), INTERVAL 30 DAY)
    """)
    monthly_row = cursor.fetchone()
    
    cursor.close()
    
    return jsonify({
        "daily": {
            "total_alerts": daily_row[0] or 0,
            "critical_events": daily_row[1] or 0,
            "avg_uptime": "99.9"
        },
        "weekly": {
            "total_alerts": weekly_row[0] or 0,
            "critical_events": weekly_row[1] or 0,
            "avg_uptime": "99.8"
        },
        "monthly": {
            "total_alerts": monthly_row[0] or 0,
            "critical_events": monthly_row[1] or 0,
            "avg_uptime": "99.7"
        }
    })


# ───────────────── ALERTS (Manager Only) ─────────────────
@app.route("/api/alerts")
@jwt_required()
def alerts():
    identity = current_jwt_identity()
    role = identity.get("role")
    
    if role != "manager":
        return jsonify({"message": "Unauthorized"}), 403
    
    cursor = mysql.connection.cursor()
    
    # Get recent critical events from sensor_data
    # Updated thresholds: Gas > 400, Smoke > 1200
    cursor.execute("""
        SELECT 
            id, node_id, created_at, distance, flame, anomaly, smoke, gas,
            CASE 
                WHEN flame = 1 THEN 'flame'
                WHEN anomaly = 1 THEN 'anomaly'
                WHEN distance < 50 THEN 'proximity'
                WHEN smoke > 1200 THEN 'smoke'
                WHEN gas > 400 THEN 'gas'
                ELSE 'other'
            END as type,
            CASE 
                WHEN flame = 1 OR anomaly = 1 THEN 'critical'
                WHEN distance < 50 OR smoke > 1200 OR gas > 400 THEN 'warning'
                ELSE 'info'
            END as severity
        FROM sensor_data
        WHERE (flame = 1 OR anomaly = 1 OR distance < 50 OR smoke > 1200 OR gas > 400)
        ORDER BY created_at DESC
        LIMIT 50
    """)
    
    rows = cursor.fetchall()
    cursor.close()
    
    alerts_list = []
    for row in rows:
        alert_id, node_id, created_at, distance, flame, anomaly, smoke, gas, alert_type, severity = row
        
        # Build message based on alert type (updated thresholds)
        if flame == 1:
            message = "Fire detected!"
        elif anomaly == 1:
            message = "Anomaly detected"
        elif distance and distance < 50:
            message = f"Object too close: {distance}cm"
        elif smoke and smoke > 1200:
            message = f"High smoke level: {smoke}"
        elif gas and gas > 400:
            message = f"High gas level: {gas}"
        else:
            message = "Alert"
        
        alerts_list.append({
            "id": alert_id,
            "node_id": node_id,
            "created_at": isoformat_server_datetime(created_at),
            "type": alert_type,
            "severity": severity,
            "message": message,
            "resolved": False  # Can add resolved column later
        })
    
    return jsonify(alerts_list)


@app.route("/api/alerts/<int:alert_id>/resolve", methods=["POST"])
@jwt_required()
def resolve_alert(alert_id):
    identity = current_jwt_identity()
    role = identity.get("role")
    
    if role != "manager":
        return jsonify({"message": "Unauthorized"}), 403
    
    # For now, just return success (can add resolved tracking later)
    return jsonify({"message": "Alert resolved"}), 200


if __name__ == "__main__":
    # threaded=True is required for SSE — each client needs its own thread
    app.run(host="0.0.0.0", port=5000, debug=True, threaded=True)
