# openscad-viewer
Simple openscad model viewer with camera controls.

## Features
* Browser UI
  * Render the model (put the file-name in the title bar)
  * Camera controls: zoom, pan, rotate
* MCP tools
  * `open` opens a model file to the viewer
  * `view` get a rendered image at a particular angle and distance
* Interaction
  * when a `view` request is made the UI updates;  i.e. the user "sees" what the agent is looking at
  * when the model file changes the UI updates automatically

## Architecture
* Run via `npx openscad-viewer`
* Nodejs + express + react
