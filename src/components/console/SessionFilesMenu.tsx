import * as DropdownMenuPrimitive from "@radix-ui/react-dropdown-menu";
import { Camera, ChevronDown, FolderOpen, History, Upload } from "lucide-react";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";

/** Files menu. Content portals into portalContainer so it stays visible in fullscreen. */
export function SessionFilesMenu({
  disabled, filesDisabled, screenshotDisabled, onBrowse, onSend, onScreenshot, onHistory, portalContainer,
}: {
  disabled?: boolean; filesDisabled?: boolean; screenshotDisabled?: boolean;
  onBrowse: () => void; onSend: () => void; onScreenshot: () => void; onHistory: () => void;
  portalContainer?: HTMLElement | null;
}) {
  const item = "cursor-pointer text-white/85 focus:bg-white/10 focus:text-white";
  return (
    <DropdownMenu modal={false}>
      <DropdownMenuTrigger asChild disabled={disabled}>
        <Button type="button" size="sm" variant="outline" data-testid="button-files-menu" aria-label="Files"
          className="border-white/20 bg-white/5 text-white hover:bg-white/10 hover:text-white">
          <FolderOpen className="h-3.5 w-3.5" /> <span className="hidden sm:inline">Files</span>
          <ChevronDown className="h-3 w-3 opacity-60" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuPrimitive.Portal container={portalContainer ?? undefined}>
        <DropdownMenuPrimitive.Content align="end" sideOffset={4} collisionPadding={8}
          className="z-[60] max-h-[var(--radix-dropdown-menu-content-available-height)] min-w-[12rem] max-w-[calc(100vw-16px)] overflow-y-auto rounded-md border border-white/10 bg-[#0F172A] p-1 text-sm text-white shadow-md">
          <DropdownMenuItem data-testid="menu-browse-remote" disabled={filesDisabled} onSelect={onBrowse} className={item}>
            <FolderOpen /> Browse remote files
          </DropdownMenuItem>
          <DropdownMenuItem data-testid="menu-send-files" disabled={filesDisabled} onSelect={onSend} className={item}>
            <Upload /> Send files
          </DropdownMenuItem>
          <DropdownMenuItem data-testid="menu-take-screenshot" disabled={screenshotDisabled} onSelect={onScreenshot} className={item}>
            <Camera /> Take screenshot
          </DropdownMenuItem>
          <DropdownMenuSeparator className="bg-white/10" />
          <DropdownMenuItem data-testid="menu-transfer-history" onSelect={onHistory} className={item}>
            <History /> Transfer history
          </DropdownMenuItem>
        </DropdownMenuPrimitive.Content>
      </DropdownMenuPrimitive.Portal>
    </DropdownMenu>
  );
}
