import type { Metadata } from "next";
import { CancelButton } from "./cancel-button";

/** O convidado cancela a reunião pelo link do e-mail (com confirmação, para o link aberto por engano não cancelar). */

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Cancelar reunião", robots: { index: false, follow: false } };

export default async function CancelPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  return (
    <main style={{ fontFamily: "system-ui, -apple-system, Segoe UI, sans-serif", color: "#101828", background: "#F7F8FA", minHeight: "100vh", padding: "32px 16px" }}>
      <div style={{ maxWidth: 440, margin: "60px auto 0", background: "#fff", border: "1px solid #E4E7EC", borderRadius: 14, padding: 24, textAlign: "center" }}>
        <CancelButton token={token} />
      </div>
    </main>
  );
}
