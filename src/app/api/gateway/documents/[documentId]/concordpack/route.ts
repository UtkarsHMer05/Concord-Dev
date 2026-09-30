import { proxyConcordpackRequest } from "@/server/gateway-history-proxy";

type RouteContext = { params: Promise<{ documentId: string }> };
export async function GET(request: Request, { params }: RouteContext) {
  return proxyConcordpackRequest(request, (await params).documentId);
}
