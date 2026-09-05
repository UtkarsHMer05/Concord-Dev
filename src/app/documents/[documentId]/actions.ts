"use server";

import { ConvexHttpClient } from "convex/browser";
import { auth, clerkClient } from "@clerk/nextjs/server";

import { api } from "../../../../convex/_generated/api";
import { Id } from "../../../../convex/_generated/dataModel";

// Created lazily so module evaluation does not require the deployment env.
let convex: ConvexHttpClient | null = null;
function getConvex() {
  convex ??= new ConvexHttpClient(process.env.NEXT_PUBLIC_CONVEX_URL!);
  return convex;
}

export async function getDocuments(ids: Id<"documents">[]) {
  return await getConvex().query(api.documents.getByIds, { ids });
};

export async function getUsers() {
  const { sessionClaims } = await auth();
  const clerk = await clerkClient();

  const response = await clerk.users.getUserList({
    organizationId: [sessionClaims?.org_id as string],
  });

  const users = response.data.map((user) => ({
    id: user.id,
    name: user.fullName ?? user.primaryEmailAddress?.emailAddress ?? "Anonymous",
    avatar: user.imageUrl,
    color: "",
  }));

  return users;
}