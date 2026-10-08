import { ClipboardList, Images, Sparkles, Sprout, UserRound } from "lucide-react";

type NavItem = {
  href: string;
  label: string;
  icon: typeof Sprout;
  pathStartsWith: string[];
};

const ITEMS: NavItem[] = [
  { href: "/s", label: "问卷", icon: ClipboardList, pathStartsWith: ["/s"] },
  { href: "/trial", label: "挑战", icon: Sparkles, pathStartsWith: ["/trial"] },
  { href: "/plaza", label: "广场", icon: Sprout, pathStartsWith: ["/plaza"] },
  { href: "/showcase", label: "展示", icon: Images, pathStartsWith: ["/showcase"] },
  { href: "/me", label: "我的", icon: UserRound, pathStartsWith: ["/me"] },
];

function isActive(item: NavItem, path: string): boolean {
  return item.pathStartsWith.some((p) => path === p || path.startsWith(`${p}/`));
}

export function BottomNav() {
  const path = window.location.pathname;
  return (
    <nav
      className="fixed inset-x-0 bottom-0 z-40 border-t border-[var(--survey-card-border)] bg-[color-mix(in_srgb,var(--survey-card-bg)_85%,transparent)] px-2 pb-[env(safe-area-inset-bottom)] pt-1.5 backdrop-blur-xl"
      style={{ WebkitBackdropFilter: "blur(12px)" }}
      aria-label="主导航"
    >
      <div className="mx-auto flex max-w-md items-center justify-around">
        {ITEMS.map((item) => {
          const active = isActive(item, path);
          const Icon = item.icon;
          return (
            <a
              key={item.href}
              href={item.href}
              className={`group flex min-w-0 flex-1 flex-col items-center gap-0.5 min-h-11 rounded-xl px-2 py-1.5 text-xs font-semibold transition-all ${
                active
                  ? "text-[var(--survey-primary)]"
                  : "text-[var(--survey-muted)] hover:text-[var(--survey-heading)]"
              }`}
              aria-current={active ? "page" : undefined}
            >
              <span
                className={`grid h-9 w-9 place-items-center rounded-xl transition-transform ${
                  active ? "bg-[var(--survey-primary-soft)] scale-110" : ""
                }`}
              >
                <Icon className="h-5 w-5" strokeWidth={active ? 2.5 : 2} />
              </span>
              <span className="transition-transform">{item.label}</span>
            </a>
          );
        })}
      </div>
    </nav>
  );
}
