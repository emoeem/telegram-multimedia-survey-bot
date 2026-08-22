import { useState } from "react";

export const navigation = [
  "dashboard",
  "surveys",
  "responses",
  "analytics",
  "templates",
  "users",
  "settings",
] as const;
export type AdminSection = (typeof navigation)[number];

export function App() {
  const [section, setSection] = useState<AdminSection>("dashboard");
  return <>{navigation.map((item) => <button key={item} onClick={() => setSection(item)}>{item}</button>)}<main>{section}</main></>;
}
