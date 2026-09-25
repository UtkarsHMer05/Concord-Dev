import { proxyProofRequest } from "@/server/gateway-history-proxy";

type RouteContext = { params: Promise<{ documentId: string }> };

export async function GET(request: Request, { params }: RouteContext) {
  const { documentId } = await params;
  return proxyProofRequest(request, documentId);
}
