import { proxyConcordpackRequest } from "@/server/gateway-history-proxy";

export async function POST(request: Request) {
  return proxyConcordpackRequest(request);
}
