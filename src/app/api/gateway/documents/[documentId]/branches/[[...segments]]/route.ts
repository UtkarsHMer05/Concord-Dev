import { proxyBranchRequest } from "@/server/gateway-history-proxy";

type Context = { params: Promise<{ documentId: string; segments?: string[] }> };
export async function GET(request: Request, { params }: Context) {
  const { documentId, segments } = await params;
  return proxyBranchRequest(request, documentId, segments);
}
export async function POST(request: Request, { params }: Context) {
  const { documentId, segments } = await params;
  return proxyBranchRequest(request, documentId, segments);
}
