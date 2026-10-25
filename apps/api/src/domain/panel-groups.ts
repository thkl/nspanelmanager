/** Validates the short MQTT-safe group key assigned to a panel profile. */
export function isValidPanelGroupName(value: string): boolean {
  return /^[A-Za-z0-9_-]{1,40}$/.test(value);
}

/** Returns the manager command topic for one panel group's temporary settings. */
export function panelGroupSettingsTopic(groupName: string): string {
  return `nspanelmanager/groups/${groupName}/cmnd/settings`;
}
