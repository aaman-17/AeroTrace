import type { CreateExpressContextOptions } from "@trpc/server/adapters/express";
import type { User } from "../../drizzle/schema";
import { sdk } from "./sdk";
import { ENV } from "./env";

export type TrpcContext = {
  req: CreateExpressContextOptions["req"];
  res: CreateExpressContextOptions["res"];
  user: User | null;
};

export async function createContext(
  opts: CreateExpressContextOptions
): Promise<TrpcContext> {
  let user: User | null = null;

  try {
    user = await sdk.authenticateRequest(opts.req);
  } catch (error) {
    // Authentication is optional for public procedures. In local development,
    // allow the prototype to run without OAuth or a Manus account.
    user = ENV.localGuestMode ? {
      id: 0, openId: "local-guest", name: "Local Guest", email: null,
      loginMethod: "local", role: "user", createdAt: new Date(),
      updatedAt: new Date(), lastSignedIn: new Date(),
    } : null;
  }

  return {
    req: opts.req,
    res: opts.res,
    user,
  };
}
