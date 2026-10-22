import type { Metadata } from "next";
import { publicForm } from "@/lib/core/forms";
import { serverSql } from "@/lib/xodos/db";
import { PublicForm } from "./public-form";

/** Página pública do formulário: o lead responde e vira negócio no CRM da agência. */

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Formulário", robots: { index: false, follow: false } };

export default async function FormPage({ params }: { params: Promise<{ code: string }> }) {
  const { code } = await params;
  const form = await publicForm(await serverSql(), code).catch(() => null);
  return (
    <main style={{ fontFamily: "system-ui, -apple-system, Segoe UI, sans-serif", color: "#101828", background: "#F7F8FA", minHeight: "100vh", padding: "32px 16px" }}>
      <div style={{ maxWidth: 520, margin: "0 auto" }}>
        {form ? <PublicForm code={code} form={form} /> : <p style={{ textAlign: "center", color: "#667085", marginTop: 80 }}>Formulário não encontrado.</p>}
      </div>
    </main>
  );
}
