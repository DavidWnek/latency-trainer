import { defineConfig } from 'vite';

// Relative asset paths so the build works from any sub-path, e.g. a GitHub Pages
// project site at https://<user>.github.io/<repo>/.
export default defineConfig({
  base: './',
});
