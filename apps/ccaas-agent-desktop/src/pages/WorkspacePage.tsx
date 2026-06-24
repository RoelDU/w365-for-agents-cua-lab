import { ActiveCallPanel } from "@/components/workflow/ActiveCallPanel";
import { Customer360Panel } from "@/components/workflow/Customer360Panel";
import { RightRail } from "@/components/workflow/RightRail";
import { CallPlaybackDriver } from "@/components/workflow/CallPlaybackDriver";

export function WorkspacePage() {
  return (
    <div className="grid h-full min-h-0 grid-cols-1 gap-3 overflow-y-auto p-3 [grid-auto-rows:max-content] min-[720px]:grid-cols-[minmax(0,1fr)_280px] min-[720px]:overflow-hidden min-[720px]:[grid-auto-rows:auto] min-[1100px]:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_300px]">
      <CallPlaybackDriver />
      <div className="contents min-[720px]:flex min-[720px]:min-h-0 min-[720px]:flex-col min-[720px]:gap-3 min-[1100px]:contents">
        <div className="min-h-0 min-[720px]:flex-1">
          <ActiveCallPanel />
        </div>
        <div className="min-h-0 min-[720px]:flex-1">
          <Customer360Panel />
        </div>
      </div>
      <div className="min-h-0">
        <RightRail />
      </div>
    </div>
  );
}
