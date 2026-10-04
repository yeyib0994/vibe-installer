import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";

type Kind = "ok" | "warn" | "error";

interface Item {
  id: number;
  text: string;
  kind: Kind;
}
interface Ctx {
  push: (text: string, kind?: Kind) => void;
}

const ToastCtx = createContext<Ctx>({ push: () => {} });

const KIND_CLS: Record<Kind, string> = {
  ok: "border-ok/40 bg-ok/10 text-ok",
  warn: "border-warn/40 bg-warn/10 text-warn",
  error: "border-danger/40 bg-danger/10 text-danger",
};

const GLYPH: Record<Kind, string> = { ok: "✔", warn: "▲", error: "✕" };

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<Item[]>([]);
  const seq = useRef(0);
  const timers = useRef(new Map<number, ReturnType<typeof setTimeout>>());

  const remove = useCallback((id: number) => {
    const timer = timers.current.get(id);
    if (timer !== undefined) {
      clearTimeout(timer);
      timers.current.delete(id);
    }
    setItems((x) => x.filter((t) => t.id !== id));
  }, []);

  const push = useCallback((text: string, kind: Kind = "ok") => {
    const id = ++seq.current;
    setItems((x) => [...x, { id, text, kind }]);
    timers.current.set(id, setTimeout(() => remove(id), 3_200));
  }, [remove]);

  useEffect(() => {
    const map = timers.current;
    return () => {
      for (const timer of map.values()) clearTimeout(timer);
      map.clear();
    };
  }, []);

  const ctx = useMemo(() => ({ push }), [push]);

  return (
    <ToastCtx.Provider value={ctx}>
      {children}
      <div data-toast-root className="fixed bottom-5 right-5 z-[60] flex w-80 flex-col gap-2">
        {items.map((t) => (
          <div
            key={t.id}
            className={`flex items-start gap-2 rounded-card border px-3 py-2.5 text-xs shadow-pop ${KIND_CLS[t.kind]}`}
          >
            <span className="font-mono">{GLYPH[t.kind]}</span>
            <span className="flex-1 break-words">{t.text}</span>
            <button aria-label="关闭提示" className="opacity-60 hover:opacity-100" onClick={() => remove(t.id)}>✕</button>
          </div>
        ))}
      </div>
    </ToastCtx.Provider>
  );
}

export const useToast = () => useContext(ToastCtx).push;
