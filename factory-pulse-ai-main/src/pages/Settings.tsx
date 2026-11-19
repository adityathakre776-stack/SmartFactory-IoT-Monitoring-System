import { useState } from "react";
import { motion } from "framer-motion";
import { Link } from "react-router-dom";
import { ArrowLeft, Settings as SettingsIcon, Bell, Shield, Palette, Database } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { useAuth } from "@/context/AuthContext";

const Settings = () => {
  const { fullName } = useAuth();
  const [notifications, setNotifications] = useState(true);
  const [emailAlerts, setEmailAlerts] = useState(true);
  const [soundAlerts, setSoundAlerts] = useState(true);
  const [refreshInterval, setRefreshInterval] = useState("5");

  return (
    <div className="min-h-screen bg-background p-4">
      <div className="max-w-4xl mx-auto">
        <div className="flex items-center gap-4 mb-6">
          <Link to="/dashboard">
            <Button variant="ghost" size="icon">
              <ArrowLeft className="w-5 h-5" />
            </Button>
          </Link>
          <div className="flex items-center gap-3">
            <SettingsIcon className="w-8 h-8 text-primary" />
            <h1 className="text-3xl font-bold">Settings</h1>
          </div>
        </div>

        <div className="space-y-6">
          {/* Notifications */}
          <Card className="p-6">
            <div className="flex items-center gap-3 mb-6">
              <Bell className="w-6 h-6 text-primary" />
              <h2 className="text-xl font-semibold">Notifications</h2>
            </div>
            <div className="space-y-4">
              <div className="flex items-center justify-between">
                <div>
                  <Label htmlFor="notifications">Enable Notifications</Label>
                  <p className="text-sm text-muted-foreground">
                    Receive browser notifications for alerts
                  </p>
                </div>
                <Switch
                  id="notifications"
                  checked={notifications}
                  onCheckedChange={setNotifications}
                />
              </div>
              <div className="flex items-center justify-between">
                <div>
                  <Label htmlFor="email">Email Alerts</Label>
                  <p className="text-sm text-muted-foreground">
                    Send email notifications for critical events
                  </p>
                </div>
                <Switch
                  id="email"
                  checked={emailAlerts}
                  onCheckedChange={setEmailAlerts}
                />
              </div>
              <div className="flex items-center justify-between">
                <div>
                  <Label htmlFor="sound">Sound Alerts</Label>
                  <p className="text-sm text-muted-foreground">
                    Play sound when alerts are triggered
                  </p>
                </div>
                <Switch
                  id="sound"
                  checked={soundAlerts}
                  onCheckedChange={setSoundAlerts}
                />
              </div>
            </div>
          </Card>

          {/* Data Refresh */}
          <Card className="p-6">
            <div className="flex items-center gap-3 mb-6">
              <Database className="w-6 h-6 text-primary" />
              <h2 className="text-xl font-semibold">Data Refresh</h2>
            </div>
            <div className="space-y-4">
              <div>
                <Label htmlFor="refresh">Refresh Interval (seconds)</Label>
                <Input
                  id="refresh"
                  type="number"
                  value={refreshInterval}
                  onChange={(e) => setRefreshInterval(e.target.value)}
                  className="mt-2"
                  min="1"
                  max="60"
                />
                <p className="text-sm text-muted-foreground mt-2">
                  How often to refresh sensor data (1-60 seconds)
                </p>
              </div>
            </div>
          </Card>

          {/* Security */}
          <Card className="p-6">
            <div className="flex items-center gap-3 mb-6">
              <Shield className="w-6 h-6 text-primary" />
              <h2 className="text-xl font-semibold">Security</h2>
            </div>
            <div className="space-y-4">
              <div>
                <Label>Account Email</Label>
                <p className="text-sm text-muted-foreground mt-1">
                  {fullName || "User"}
                </p>
              </div>
              <Button variant="outline">Change Password</Button>
            </div>
          </Card>

          {/* Appearance */}
          <Card className="p-6">
            <div className="flex items-center gap-3 mb-6">
              <Palette className="w-6 h-6 text-primary" />
              <h2 className="text-xl font-semibold">Appearance</h2>
            </div>
            <div className="space-y-4">
              <p className="text-sm text-muted-foreground">
                Theme settings are managed globally. Use the theme toggle in the header to switch between light and dark mode.
              </p>
            </div>
          </Card>

          <div className="flex justify-end gap-4">
            <Button variant="outline">Cancel</Button>
            <Button>Save Changes</Button>
          </div>
        </div>
      </div>
    </div>
  );
};

export default Settings;
