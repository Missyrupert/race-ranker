import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Race Ranker",
  description: "UK horse racing betting assistant — ranked selections with win probabilities",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body style={{ margin: 0, fontFamily: "'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif", background: "#0f1117", color: "#e4e4e7" }}>
        {children}
      </body>
    </html>
  );
}
