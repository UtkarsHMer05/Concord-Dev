import Link from "next/link";
import Image from "next/image";
import { UserButton, OrganizationSwitcher } from "@clerk/nextjs";

import { SearchInput } from "./search-input";

/**
 * Home page header: brand on the left, the document search field in the
 * middle, and Clerk's organization/account switchers on the right.
 *
 * All redirect URLs below point back to "/" so switching organizations
 * never strands the user on a document another org may not have access to
 * — the home listing re-requests with the new org scope (RBAC is applied
 * server-side on /api/documents).
 */
export const Navbar = () => (
  <nav className="flex items-center justify-between h-full w-full gap-x-2">
    <BrandBlock />
    <SearchInput />
    <AccountBlock />
  </nav>
);

/** Brand mark + wordmark; collapses to logo-only on phones. */
const BrandBlock = () => (
  <div className="flex gap-3 items-center shrink-0 pr-2 sm:pr-6">
    <Link href="/" aria-label="Concord home">
      <Image src="/logo.svg" alt="Concord logo" width={36} height={36} priority />
    </Link>
    <h3 className="text-xl hidden sm:block">Concord</h3>
  </div>
);

/**
 * Organization + account controls. All Clerk redirect URLs point back to "/"
 * so switching organizations never strands the user on a document the new
 * org cannot access — the listing re-requests with the new org scope.
 */
const AccountBlock = () => {
  const clerkRedirects = {
    afterCreateOrganizationUrl: "/",
    afterLeaveOrganizationUrl: "/",
    afterSelectOrganizationUrl: "/",
    afterSelectPersonalUrl: "/",
  };

  return (
    <div className="flex gap-3 items-center pl-2 sm:pl-6 shrink-0">
      <OrganizationSwitcher {...clerkRedirects} />
      <UserButton />
    </div>
  );
};
