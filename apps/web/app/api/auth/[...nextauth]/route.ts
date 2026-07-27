import NextAuth from "next-auth";

import { createServerComposition } from "../../../../src/server-composition";

function authHandler() {
  return NextAuth(createServerComposition().authOptions);
}

export async function GET(request: Request, context: unknown) {
  return authHandler()(request, context);
}

export async function POST(request: Request, context: unknown) {
  return authHandler()(request, context);
}
