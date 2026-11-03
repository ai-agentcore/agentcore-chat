import type { Metadata, Viewport } from "next";
import { frontendConfig, frontendThemeCss } from "@/config/frontend";
import "./globals.css";

export const metadata: Metadata = {
  title: frontendConfig.brand.title,
  description: frontendConfig.brand.description,
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: frontendConfig.theme.light.background },
    { media: "(prefers-color-scheme: dark)", color: frontendConfig.theme.dark.background },
  ],
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="zh-CN" data-theme={frontendConfig.theme.defaultMode}>
    <head><style id="frontend-theme">{frontendThemeCss()}</style></head>
    <body>{children}</body>
  </html>;
}
