import { NextResponse } from "next/server";
import { cancelByToken } from "@/lib/core/bookings";
import { bookingDeps } from "@/lib/core/bookings-google";
import { serverSql } from "@/lib/xodos/db";
import { fail } from "@/lib/xodos/http";

/** POST /api/public/bookings/cancel/:token  o convidado cancela pelo link do e-mail. */
export async function POST(_request: Request, { params }: { params: Promise<{ token: string }> }) {
  try {
    return NextResponse.json(await cancelByToken(await bookingDeps(await serverSql()), (await params).token));
  } catch (error) {
    return fail(error);
  }
}
