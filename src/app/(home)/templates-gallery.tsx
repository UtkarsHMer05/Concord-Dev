"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";

import {
  CarouselPrevious,
  CarouselNext,
  CarouselItem,
  CarouselContent,
  Carousel,
} from "@/components/ui/carousel";
import { cn } from "@/lib/utils";
import { templates } from "@/constants/templates";
import { createDocumentAction } from "@/app/actions/documents";

/**
 * Template starter strip on the home page.
 *
 * Clicking a card creates a fresh document server-side from the template's
 * `initialContent` and routes the user straight into the editor. A single
 * `isCreating` flag guards against double-clicks firing two creates (the
 * pointer-events lock + disabled buttons cover the whole gallery while any
 * creation is in flight — per-card disabling alone would race).
 */
export const TemplatesGallery = () => {
  const router = useRouter();
  const [isCreating, setIsCreating] = useState(false);

  const createFromTemplate = async (
    templateTitle: string,
    initialContent: string
  ) => {
    setIsCreating(true);
    const result = await createDocumentAction({
      title: templateTitle,
      initialContent,
    });
    if (result.ok) {
      toast.success("Document created");
      router.push(`/documents/${result.data.id}`);
    } else {
      toast.error("Something went wrong");
      // Re-enable the gallery so the user can retry.
      setIsCreating(false);
    }
  };

  return (
    <div className="bg-[#F1F3F4]">
      <div className="max-w-screen-xl mx-auto px-4 md:px-16 py-6 flex flex-col gap-y-4">
        <h3 className="font-medium">Start a new document</h3>
        <TemplateCarousel busy={isCreating} onChoose={createFromTemplate} />
      </div>
    </div>
  );
};

/** Scrollable strip of template cards with prev/next arrows. */
const TemplateCarousel = ({
  busy,
  onChoose,
}: {
  busy: boolean;
  onChoose: (label: string, initialContent: string) => Promise<void>;
}) => (
  <Carousel>
    <CarouselContent className="-ml-4">
      {templates.map((template) => (
        <CarouselItem
          key={template.id}
          className="basis-1/2 sm:basis-1/3 md:basis-1/4 lg:basis-1/5 xl:basis-1/6 2xl:basis-[14.285714%] pl-4"
        >
          <TemplateCard template={template} busy={busy} onChoose={onChoose} />
        </CarouselItem>
      ))}
    </CarouselContent>
    <CarouselPrevious />
    <CarouselNext />
  </Carousel>
);

/**
 * One template: an SVG preview button (aspect-locked) with its name below.
 * The parent's `busy` flag locks all cards during any creation so a second
 * click cannot race a second create call.
 */
const TemplateCard = ({
  template,
  busy,
  onChoose,
}: {
  template: (typeof templates)[number];
  busy: boolean;
  onChoose: (label: string, initialContent: string) => Promise<void>;
}) => (
  <div
    className={cn(
      "aspect-[3/4] flex flex-col gap-y-2.5",
      // Freeze interactions gallery-wide during creation.
      busy && "pointer-events-none opacity-50"
    )}
  >
    <button
      disabled={busy}
      onClick={() => void onChoose(template.label, template.initialContent)}
      aria-label={`Create a new document from the ${template.label} template`}
      style={{
        backgroundImage: `url(${template.imageUrl})`,
        backgroundSize: "cover",
        backgroundPosition: "center",
        backgroundRepeat: "no-repeat",
      }}
      className="size-full hover:border-blue-500 rounded-sm border hover:bg-blue-50 transition flex flex-col items-center justify-center gap-y-4 bg-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring motion-reduce:transition-none"
    />
    <p className="text-sm font-medium truncate">
      {template.label}
    </p>
  </div>
);
