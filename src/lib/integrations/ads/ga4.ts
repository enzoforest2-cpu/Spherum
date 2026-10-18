import { requestJson, type Fetch } from "../http";

/** Google Analytics 4: propriedades pela Admin API e relatório diário por canal pela Data API. */

export type Ga4Property = { externalId: string; name: string; account: string };
export type Ga4Row = { day: string; channel: string; sessions: number; users: number; keyEvents: number; revenue: number };

export async function listGa4Properties(a: { accessToken: string; http: Fetch }): Promise<Ga4Property[]> {
  const out: Ga4Property[] = [];
  let pageToken: string | undefined;
  for (let page = 0; page < 20; page++) {
    const url = new URL("https://analyticsadmin.googleapis.com/v1beta/accountSummaries");
    url.searchParams.set("pageSize", "200");
    if (pageToken) url.searchParams.set("pageToken", pageToken);
    const r: { accountSummaries?: { displayName?: string; propertySummaries?: { property: string; displayName?: string }[] }[]; nextPageToken?: string } =
      await requestJson(a.http, url.toString(), { bearer: a.accessToken });
    for (const acc of r.accountSummaries ?? []) {
      for (const p of acc.propertySummaries ?? []) {
        out.push({ externalId: p.property.replace("properties/", ""), name: p.displayName ?? p.property, account: acc.displayName ?? "" });
      }
    }
    pageToken = r.nextPageToken;
    if (!pageToken) break;
  }
  return out;
}

export async function ga4Daily(a: { accessToken: string; http: Fetch }, propertyId: string, since: string, until: string): Promise<Ga4Row[]> {
  const r = await requestJson<{ rows?: { dimensionValues: { value: string }[]; metricValues: { value: string }[] }[] }>(
    a.http,
    `https://analyticsdata.googleapis.com/v1beta/properties/${propertyId.replace(/\D/g, "")}:runReport`,
    {
      method: "POST",
      bearer: a.accessToken,
      json: {
        dateRanges: [{ startDate: since, endDate: until }],
        dimensions: [{ name: "date" }, { name: "sessionDefaultChannelGroup" }],
        metrics: [{ name: "sessions" }, { name: "totalUsers" }, { name: "keyEvents" }, { name: "totalRevenue" }],
        limit: 10000,
      },
    },
  );
  return (r.rows ?? []).map((row) => {
    const d = row.dimensionValues[0].value;
    return {
      day: `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}`,
      channel: row.dimensionValues[1]?.value ?? "",
      sessions: Number(row.metricValues[0]?.value) || 0,
      users: Number(row.metricValues[1]?.value) || 0,
      keyEvents: Number(row.metricValues[2]?.value) || 0,
      revenue: Number(row.metricValues[3]?.value) || 0,
    };
  });
}
