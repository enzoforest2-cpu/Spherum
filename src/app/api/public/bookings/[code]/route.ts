import { NextResponse } from "next/server";
import { book, publicBooking } from "@/lib/core/bookings";
import { bookingDeps } from "@/lib/core/bookings-google";
import { clientIp, leadSalt } from "@/lib/core/http";
import { serverSql } from "@/lib/xodos/db";
import { fail } from "@/lib/xodos/http";

type Ctx = { params: Promise<{ code: string }> };

/** GET /api/public/bookings/:code  o tipo de reunião e os horários livres (sem login). */
export async function GET(_request: Request, { params }: Ctx) {
  try {
    return NextResponse.json(await publicBooking(await bookingDeps(await serverSql()), (await params).code));
  } catch (error) {
    return fail(error);
  }
}

/** POST /api/public/bookings/:code  { start, name, email, phone?, notes? }  marca a reunião. */
export async function POST(request: Request, { params }: Ctx) {
  try {
    const deps = await bookingDeps(await serverSql());
    return NextResponse.json(await book(deps, (await params).code, await request.json(), clientIp(request), leadSalt()), { status: 201 });
  } catch (error) {
    return fail(error);
  }
}
