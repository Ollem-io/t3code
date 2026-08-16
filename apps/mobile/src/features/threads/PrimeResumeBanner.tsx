import { useState } from "react";
import { Pressable, Text, View } from "react-native";

import {
  PRIME_RESUME_ARCHIVE_NOTE,
  PRIME_RESUME_STOP_NOTE,
  primeResumeSurface,
  type PrimeResumeIntent,
  type PrimeResumeModel,
} from "@t3tools/client-runtime/prime-resume";

export interface PrimeResumeBannerProps {
  readonly providerName: string | null | undefined;
  readonly model: PrimeResumeModel;
  readonly onRecover: (intent: PrimeResumeIntent) => void;
}

/**
 * PA-B04 mobile twin of the web resume banner.
 *
 * Both surfaces derive title, detail, composer gate and recovery choices from
 * the same `primeResumeSurface`, so a phone and a laptop looking at one thread
 * cannot describe its session differently. Phones never own Prime setup: this
 * is a truthful view plus the same three ways out.
 */
export function PrimeResumeBanner(props: PrimeResumeBannerProps) {
  const [confirming, setConfirming] = useState(false);
  const surface = primeResumeSurface(props.providerName, props.model);
  if (surface.kind === "hidden") return null;
  const freshChoice = surface.choices.find((choice) => choice.kind === "fresh");

  return (
    <View accessibilityLabel={`Prime Agent resume: ${surface.kind}`} className="mt-1 px-2 py-1">
      <Text className="text-xs text-foreground-muted">{surface.title}</Text>
      <Text className="mt-1 text-xs text-foreground-muted">{surface.detail}</Text>
      {surface.composerBlocked ? (
        <Text className="mt-1 text-xs text-red-500">
          Sending is paused for this thread until you choose what to do, so no message can start a
          new session by accident.
        </Text>
      ) : null}
      <View className="mt-1 flex-row gap-2">
        {surface.choices.map((choice) => (
          <Pressable
            key={choice.kind}
            accessibilityRole="button"
            accessibilityLabel={choice.label}
            className="rounded-full bg-neutral-200 px-3 py-2 dark:bg-neutral-700"
            onPress={() => {
              if (choice.kind === "fresh") {
                setConfirming(true);
                return;
              }
              props.onRecover({ kind: choice.kind });
            }}
          >
            <Text>{choice.label}</Text>
          </Pressable>
        ))}
      </View>
      {freshChoice?.kind === "fresh" && confirming ? (
        <View className="mt-1">
          <Text className="text-xs text-foreground-muted">{freshChoice.confirm}</Text>
          <Text className="mt-1 text-xs text-foreground-muted">{PRIME_RESUME_STOP_NOTE}</Text>
          <Text className="mt-1 text-xs text-foreground-muted">{PRIME_RESUME_ARCHIVE_NOTE}</Text>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Confirm new Prime Agent session"
            className="mt-1 rounded-full bg-neutral-200 px-3 py-2 dark:bg-neutral-700"
            onPress={() => {
              setConfirming(false);
              props.onRecover({ kind: "fresh", discardCursor: freshChoice.discardCursor });
            }}
          >
            <Text>Start a new session</Text>
          </Pressable>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Cancel new Prime Agent session"
            className="mt-1 rounded-full bg-neutral-200 px-3 py-2 dark:bg-neutral-700"
            onPress={() => {
              setConfirming(false);
            }}
          >
            <Text>Cancel</Text>
          </Pressable>
        </View>
      ) : null}
    </View>
  );
}
