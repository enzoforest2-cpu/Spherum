import type { Metadata } from "next";
import { publicBooking } from "@/lib/core/bookings";
import { bookingDeps } from "@/lib/core/bookings-google";
import { serverSql } from "@/lib/xodos/db";
import { BookingPicker } from "./booking-picker";

/** Página pública de agendamento: o convidado escolhe o dia e o horário livre. */

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Agendar reunião", robots: { index: false, follow: false } };

export default async function BookingPage({ params }: { params: Promise<{ code: string }> }) {
  const { code } = await params;
  const data = await publicBooking(await bookingDeps(await serverSql()), code).catch(() => null);
  return (
    <main style={{ fontFamily: "system-ui, -apple-system, Segoe UI, sans-serif", color: "#101828", background: "#F7F8FA", minHeight: "100vh", padding: "32px 16px" }}>
      <div style={{ maxWidth: 560, margin: "0 auto" }}>
        {data ? <BookingPicker code={code} data={data} /> : <p style={{ textAlign: "center", color: "#667085", marginTop: 80 }}>Agenda não encontrada.</p>}
      </div>
    </main>
  );
}
