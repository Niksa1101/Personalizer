import type { LucideIcon } from "lucide-react"
import {
  Clapperboard,
  LayoutDashboard,
  ListChecks,
  Megaphone,
  ScrollText,
  Settings,
  Upload,
  Users,
} from "lucide-react"

export type NavItem = {
  label: string
  href: string
  icon: LucideIcon
}

export type NavGroup = {
  label: string
  items: NavItem[]
}

export const NAV_GROUPS: NavGroup[] = [
  {
    label: "Work",
    items: [
      { label: "Dashboard", href: "/", icon: LayoutDashboard },
      { label: "Leads", href: "/leads", icon: Users },
      { label: "Queue", href: "/queue", icon: ListChecks },
    ],
  },
  {
    label: "Setup",
    items: [
      { label: "Campaigns", href: "/campaigns", icon: Megaphone },
      { label: "Intro Videos", href: "/intros", icon: Clapperboard },
      { label: "Import", href: "/import", icon: Upload },
    ],
  },
  {
    label: "System",
    items: [
      { label: "Logs", href: "/logs", icon: ScrollText },
      { label: "Settings", href: "/settings", icon: Settings },
    ],
  },
]

export const NAV_ITEMS: NavItem[] = NAV_GROUPS.flatMap((group) => group.items)

export function navTitleForPathname(pathname: string): string {
  if (pathname === "/") return "Dashboard"

  const exact = NAV_ITEMS.find((item) => item.href === pathname)
  if (exact) return exact.label

  if (pathname.startsWith("/campaigns/")) return "Campaign"

  const prefix = NAV_ITEMS.find(
    (item) => item.href !== "/" && pathname.startsWith(item.href),
  )
  return prefix?.label ?? "Personalizer"
}

export function isNavItemActive(pathname: string, href: string): boolean {
  if (href === "/") return pathname === "/"
  return pathname === href || pathname.startsWith(`${href}/`)
}
