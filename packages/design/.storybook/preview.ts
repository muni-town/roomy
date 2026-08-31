import type { Preview } from "@storybook/svelte";
import { withThemeByClassName } from "@storybook/addon-themes";
import "@fontsource-variable/inter";
import "../src/storybook.css";

const preview: Preview = {
  decorators: [
    // Toggles the `.dark` class on <html>, exactly like app-lite's
    // applyThemeMode() (packages/design/src/utils/theme.ts). All design
    // components key their dark styles off `@custom-variant dark (&:is(.dark *))`.
    withThemeByClassName({
      themes: {
        light: "",
        dark: "dark",
      },
      defaultTheme: "light",
      parentSelector: "html",
    }),
  ],
  parameters: {
    controls: { expanded: true },
    layout: "padded",
    options: {
      storySort: (a, b) =>
        a.title === b.title
          ? 0
          : a.id.localeCompare(b.id, undefined, { numeric: true }),
    },
  },
};

export default preview;
