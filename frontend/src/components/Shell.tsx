import { Outlet } from "react-router-dom";
import { TopBar } from "./TopBar";

export function Shell() {
  return (
    <div className="min-h-full">
      <TopBar />
      <main className="mx-auto w-full max-w-[1400px] px-6 py-6">
        <Outlet />
      </main>
    </div>
  );
}
