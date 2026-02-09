export const metadata = {
  title: "screenpipe action pipe",
  description: "Real-time screen content action detection",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body style={{ fontFamily: "system-ui, sans-serif", padding: "2rem", background: "#0a0a0a", color: "#fafafa" }}>
        {children}
      </body>
    </html>
  );
}
