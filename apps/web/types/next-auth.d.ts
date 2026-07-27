import "next-auth";

declare module "next-auth" {
  interface Session {
    user?: {
      email?: string | null;
      id: string;
      image?: string | null;
      name?: string | null;
    };
  }
}
