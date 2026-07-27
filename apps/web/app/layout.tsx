import type { Metadata } from "next";

import "./styles.css";

export const metadata: Metadata = {
  description: "SayHear Internal Core access boundary",
  title: "SayHear Internal Core",
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
