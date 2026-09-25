import { proxyRevisionRequest } from "@/server/gateway-history-proxy";

type RouteContext = { params: Promise<{ documentId: string; segments?: string[] }> };

export async function GET(request: Request, { params }: RouteContext) {
  const { documentId, segments } = await params;
  return proxyRevisionRequest(request, documentId, segments);
}

export async function POST(request: Request, { params }: RouteContext) {
  const { documentId, segments } = await params;
  return proxyRevisionRequest(request, documentId, segments);
}
