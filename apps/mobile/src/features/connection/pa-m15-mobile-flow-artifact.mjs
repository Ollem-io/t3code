// Standalone review artifact manifest. Every entry is a production module used by the mobile route.
// Review with: git show <sha>:<path>, or copy these source files without launching a simulator.
export const mobileFlowArtifact = Object.freeze({
  entry: "apps/mobile/src/features/threads/ThreadRouteScreen.tsx",
  components: [
    "apps/mobile/src/features/threads/ThreadDetailScreen.tsx",
    "apps/mobile/src/features/threads/ThreadComposer.tsx",
    "apps/mobile/src/features/threads/ThreadSettingsSheet.tsx",
    "apps/mobile/src/features/threads/NewTaskDraftScreen.tsx",
  ],
  presentation: ["apps/mobile/src/lib/modelOptions.ts", "apps/mobile/src/lib/primeHostStatus.ts"],
  proof: [
    "apps/mobile/src/lib/modelOptions.test.ts",
    "apps/mobile/src/lib/primeHostStatus.test.ts",
  ],
});
