import Link from "next/link";
import Image from "next/image";
import { UserButton, OrganizationSwitcher } from "@clerk/nextjs";

import { SearchInput } from "./search-input";

export const Navbar = () => {
  return (
    <nav className="flex items-center justify-between h-full w-full gap-x-2">
      <div className="flex gap-3 items-center shrink-0 pr-2 sm:pr-6">
        <Link href="/" aria-label="Concord home">
          <Image src="/logo.svg" alt="Concord logo" width={36} height={36} priority />
        </Link>
        <h3 className="text-xl hidden sm:block">Concord</h3>
      </div>
      <SearchInput />
      <div className="flex gap-3 items-center pl-2 sm:pl-6 shrink-0">
        <OrganizationSwitcher
          afterCreateOrganizationUrl="/"
          afterLeaveOrganizationUrl="/"
          afterSelectOrganizationUrl="/"
          afterSelectPersonalUrl="/"
        />
        <UserButton />
      </div>
    </nav>
  );
};
