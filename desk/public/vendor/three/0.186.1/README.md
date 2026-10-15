three.js r186 (npm `three@0.186.1`), served as static files so pano-desk works
offline. Loaded at runtime with pano-kit's `loadThree(url)` (a dynamic
`import()` of this URL), never bundled; the version is in the path.

0.186.1 ships no minified build, so these were made from the package's
`build/three.core.js` and `build/three.module.js` with esbuild:

    esbuild three.core.js   --minify --format=esm --outfile=three.core.min.js
    esbuild three.module.js --minify --format=esm --outfile=three.module.min.js
    sed -i 's#./three.core.js#./three.core.min.js#g' three.module.min.js

Types come from the `@types/three@0.186.0` dev dependency. MIT licence alongside.
