/** A short message about the browser: what failed, what was saved, what is waiting. */
import { Alert as Banner, Button } from "@heroui/react";

import { Icon } from "./icons.js";

export type Tone = "info" | "success" | "warning" | "danger";

const STATUS = {
  info: "accent",
  success: "success",
  warning: "warning",
  danger: "danger",
} as const;

type Props = {
  tone: Tone;
  title?: string;
  description: string;
  onClose?: () => void;
};

export function Alert({ tone, title, description, onClose }: Props) {
  return (
    <Banner
      className="pointer-events-auto w-[min(34rem,calc(100vw-2rem))] shadow-lg"
      status={STATUS[tone]}
    >
      <Banner.Indicator />
      <Banner.Content className="items-center text-center">
        {/* One line of its own is the alert's title, which HeroUI paints in full contrast and
            lines up with the indicator; a description under a title stays muted. */}
        <Banner.Title>{title ?? description}</Banner.Title>
        {title ? <Banner.Description>{description}</Banner.Description> : null}
      </Banner.Content>
      {onClose ? (
        <Button aria-label="Dismiss" isIconOnly onPress={onClose} size="sm" variant="ghost">
          <Icon name="close" />
        </Button>
      ) : null}
    </Banner>
  );
}
