// Resource dispatcher for all read access to Xero accounting data, plus
// connection management (list/disconnect) for the Settings page.
// See frontend/src/lib/xero.ts for the exact response shapes each resource
// must return -- that file is the contract this implements.
import {
  callXeroAccountingApi,
  corsHeaders,
  disconnectXeroConnection,
  errorResponse,
  getCallingUserId,
  getValidAccessToken,
  jsonResponse,
  listXeroConnections,
  XeroApiError,
  type XeroConnection,
} from "../_shared/xero-client.ts";

type TaxJurisdiction = "GB" | "AE" | "DE" | "IN";

interface RequestBody {
  resource: "invoices" | "contacts" | "organisation" | "revenue" | "summary" | "connections" | "disconnect";
  connectionId?: string;
}

// --- Tax bands -------------------------------------------------------
// Simplified, single-band-or-stepped corporate tax estimates per
// jurisdiction. These are deliberately conservative approximations for
// display purposes only (the UI labels this "estimated, not tax advice" --
// see dashboard.tsx and the Legislation Assistant for the real guidance
// surface). Review before relying on these for anything beyond a rough
// indicator.
function estimateCorporateTax(
  jurisdiction: TaxJurisdiction,
  netProfit: number,
): { owed: number; bandLabel: string } {
  if (netProfit <= 0) return { owed: 0, bandLabel: "No tax (loss-making)" };

  switch (jurisdiction) {
    case "GB":
      // UK: 19% small profits rate up to £50k, 25% main rate above £250k,
      // marginal relief in between -- approximated here as a straight
      // marginal step rather than the exact marginal-relief formula.
      if (netProfit <= 50_000) return { owed: netProfit * 0.19, bandLabel: "UK small profits rate (19%)" };
      if (netProfit >= 250_000) return { owed: netProfit * 0.25, bandLabel: "UK main rate (25%)" };
      return { owed: netProfit * 0.265, bandLabel: "UK marginal relief band (~26.5% effective)" };
    case "AE":
      // UAE: 0% up to AED 375k, 9% above.
      if (netProfit <= 375_000) return { owed: 0, bandLabel: "UAE 0% band (below AED 375,000)" };
      return { owed: (netProfit - 375_000) * 0.09, bandLabel: "UAE 9% band (above AED 375,000)" };
    case "DE":
      // Germany: ~15% corporate tax + solidarity surcharge + trade tax
      // varies by municipality -- approximated as a flat ~30% combined rate.
      return { owed: netProfit * 0.30, bandLabel: "Germany combined rate (~30% incl. trade tax, approx.)" };
    case "IN":
      // India: 25% base rate for domestic companies under the
      // concessional regime, plus surcharge/cess approximated into ~26%.
      return { owed: netProfit * 0.26, bandLabel: "India domestic company rate (~26% incl. cess, approx.)" };
    default:
      return { owed: 0, bandLabel: "Unknown jurisdiction" };
  }
}

function jurisdictionFromCountryCode(countryCode: string | undefined): TaxJurisdiction {
  switch (countryCode) {
    case "GB":
      return "GB";
    case "AE":
      return "AE";
    case "DE":
      return "DE";
    case "IN":
      return "IN";
    default:
      return "GB";
  }
}

// VAT/GST registration-threshold estimate. Checks the org's actual Xero
// registration status first (SalesTaxBasis != "NONE" means registered),
// falling back to a revenue-based estimate only when that's unavailable.
const VAT_THRESHOLDS_GBP: Record<TaxJurisdiction, number> = {
  GB: 90_000, // UK VAT registration threshold
  AE: 375_000 / 4.6, // AED mandatory registration threshold, roughly converted to GBP
  DE: 25_000 / 1.17, // EUR small-business threshold, roughly converted to GBP
  IN: 4_000_000 / 105, // INR GST threshold (goods), roughly converted to GBP
};

function estimateVatProximity(
  jurisdiction: TaxJurisdiction,
  salesTaxBasis: string | undefined,
  annualisedRevenueGbp: number,
) {
  const registered = !!salesTaxBasis && salesTaxBasis !== "NONE";
  const thresholdGbp = VAT_THRESHOLDS_GBP[jurisdiction];
  const proximityPercent = Math.min(100, (annualisedRevenueGbp / thresholdGbp) * 100);

  let status: "registered" | "well_under" | "approaching" | "over" = "well_under";
  if (registered) status = "registered";
  else if (proximityPercent >= 100) status = "over";
  else if (proximityPercent >= 80) status = "approaching";

  return {
    registered,
    salesTaxBasis: salesTaxBasis ?? "NONE",
    thresholdGbp,
    annualisedRevenue: annualisedRevenueGbp,
    proximityPercent,
    status,
  };
}

// --- Best-effort P&L / Balance Sheet report parsing -------------------
// Xero's Reports endpoints return a nested Rows/Cells tree rather than flat
// fields, and the exact row titles can vary slightly by report layout.
// This looks for common row labels. Treat this as a starting point, not a
// guaranteed-correct parser -- validate against real connected data,
// per the open question already flagged in the project notes about
// whether P&L parsing needs a dedicated transformer.
interface ReportRow {
  RowType?: string;
  Title?: string;
  Cells?: Array<{ Value?: string }>;
  Rows?: ReportRow[];
}

function findRowValue(rows: ReportRow[] | undefined, titleMatch: RegExp): number | null {
  if (!rows) return null;
  for (const row of rows) {
    if (row.Title && titleMatch.test(row.Title) && row.Cells && row.Cells.length > 1) {
      const raw = row.Cells[row.Cells.length - 1].Value;
      const parsed = raw ? parseFloat(raw.replace(/,/g, "")) : NaN;
      if (!isNaN(parsed)) return parsed;
    }
    const nested = findRowValue(row.Rows, titleMatch);
    if (nested !== null) return nested;
  }
  return null;
}

function extractReportRows(report: unknown): ReportRow[] {
  const r = report as { Reports?: Array<{ Rows?: ReportRow[] }> };
  return r?.Reports?.[0]?.Rows ?? [];
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    const userId = await getCallingUserId(req);
    const { resource, connectionId } = (await req.json()) as RequestBody;
    const accessToken = await getValidAccessToken(userId);

    if (resource === "connections") {
      const connections = await listXeroConnections(accessToken);
      return jsonResponse(connections);
    }

    if (resource === "disconnect") {
      if (!connectionId) throw new XeroApiError("Missing 'connectionId'.", 400);
      await disconnectXeroConnection(accessToken, connectionId);
      return jsonResponse({ ok: true });
    }

    const connections = await listXeroConnections(accessToken);
    if (connections.length === 0) {
      throw new XeroApiError("No Xero organisation connected.", 404);
    }

    if (resource === "invoices") {
      // Single-tenant convenience call: uses the first connected org.
      const data = await callXeroAccountingApi(
        accessToken,
        connections[0].tenantId,
        '/Invoices?where=Type=="ACCREC"',
      );
      return jsonResponse(data);
    }

    if (resource === "contacts") {
      const data = await callXeroAccountingApi(accessToken, connections[0].tenantId, "/Contacts");
      // Certification Checkpoint 7 (Data Integrity): exclude archived contacts.
      const body = data as { Contacts?: Array<{ ContactStatus?: string }> };
      return jsonResponse({
        Contacts: (body.Contacts ?? []).filter((c) => c.ContactStatus !== "ARCHIVED"),
      });
    }

    if (resource === "organisation") {
      const data = await callXeroAccountingApi(accessToken, connections[0].tenantId, "/Organisation");
      return jsonResponse(data);
    }

    if (resource === "revenue" || resource === "summary") {
      const warnings: string[] = [];

      const entities = await Promise.all(
        connections.map(async (conn: XeroConnection) => {
          try {
            const [orgData, plData, bsData] = await Promise.all([
              callXeroAccountingApi(accessToken, conn.tenantId, "/Organisation"),
              callXeroAccountingApi(accessToken, conn.tenantId, "/Reports/ProfitAndLoss"),
              callXeroAccountingApi(accessToken, conn.tenantId, "/Reports/BalanceSheet"),
            ]);

            const org = (orgData as { Organisations?: Array<Record<string, unknown>> }).Organisations?.[0] ?? {};
            const currency = (org.BaseCurrency as string) ?? "GBP";
            const countryCode = org.CountryCode as string | undefined;
            const salesTaxBasis = org.SalesTaxBasis as string | undefined;
            const jurisdiction = jurisdictionFromCountryCode(countryCode);

            const plRows = extractReportRows(plData);
            const revenue = findRowValue(plRows, /total income|total revenue/i) ?? 0;
            const expenses = findRowValue(plRows, /total expenses|total operating expenses/i) ?? 0;
            const netProfit = findRowValue(plRows, /net profit|net income/i) ?? revenue - expenses;
            const grossProfit = findRowValue(plRows, /gross profit/i);
            const grossMargin = grossProfit !== null && revenue !== 0 ? grossProfit / revenue : null;
            const netMargin = revenue !== 0 ? netProfit / revenue : null;

            const bsRows = extractReportRows(bsData);
            const cash = findRowValue(bsRows, /total bank|total cash/i);

            const { owed: estimatedTaxOwed, bandLabel: taxBandLabel } = estimateCorporateTax(jurisdiction, netProfit);
            const vat = estimateVatProximity(jurisdiction, salesTaxBasis, revenue);

            return {
              tenantId: conn.tenantId,
              tenantName: conn.tenantName,
              currency,
              revenue,
              expenses,
              netProfit,
              grossProfit,
              grossMargin,
              netMargin,
              cash,
              taxJurisdiction: jurisdiction,
              estimatedTaxOwed,
              taxBandLabel,
              vat,
            };
          } catch (err) {
            warnings.push(
              `${conn.tenantName}: ${err instanceof Error ? err.message : "failed to load data"}`,
            );
            return null;
          }
        }),
      );

      const validEntities = entities.filter((e): e is NonNullable<typeof e> => e !== null);

      if (resource === "revenue") {
        const totals = new Map<string, number>();
        for (const e of validEntities) totals.set(e.currency, (totals.get(e.currency) ?? 0) + e.revenue);
        return jsonResponse(Array.from(totals, ([currency, total]) => ({ currency, total })));
      }

      // resource === "summary"
      const totalsByCurrency = (pick: (e: (typeof validEntities)[number]) => number) => {
        const totals = new Map<string, number>();
        for (const e of validEntities) totals.set(e.currency, (totals.get(e.currency) ?? 0) + pick(e));
        return Array.from(totals, ([currency, total]) => ({ currency, total }));
      };

      const byCountryMap = new Map
        TaxJurisdiction,
        { entityCount: number; totalRevenue: number; totalNetProfit: number; totalEstimatedTaxOwed: number; currency: string }
      >();
      for (const e of validEntities) {
        const existing = byCountryMap.get(e.taxJurisdiction) ?? {
          entityCount: 0,
          totalRevenue: 0,
          totalNetProfit: 0,
          totalEstimatedTaxOwed: 0,
          currency: e.currency,
        };
        existing.entityCount += 1;
        existing.totalRevenue += e.revenue;
        existing.totalNetProfit += e.netProfit;
        existing.totalEstimatedTaxOwed += e.estimatedTaxOwed;
        byCountryMap.set(e.taxJurisdiction, existing);
      }

      const jurisdictionLabels: Record<TaxJurisdiction, string> = {
        GB: "United Kingdom",
        AE: "United Arab Emirates",
        DE: "Germany",
        IN: "India",
      };

      return jsonResponse({
        entities: validEntities,
        byCountry: Array.from(byCountryMap, ([jurisdiction, v]) => ({
          jurisdiction,
          jurisdictionLabel: jurisdictionLabels[jurisdiction],
          ...v,
        })),
        warnings: warnings.length > 0 ? warnings : undefined,
        consolidated: {
          revenue: totalsByCurrency((e) => e.revenue),
          expenses: totalsByCurrency((e) => e.expenses),
          netProfit: totalsByCurrency((e) => e.netProfit),
          cash: totalsByCurrency((e) => e.cash ?? 0),
          estimatedTaxOwed: totalsByCurrency((e) => e.estimatedTaxOwed),
        },
      });
    }

    throw new XeroApiError(`Unknown resource: ${resource}`, 400);
  } catch (err) {
    return errorResponse(err);
  }
});