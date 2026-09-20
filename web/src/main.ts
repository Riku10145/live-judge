import "./style.css";
import { mountBoard } from "./board.ts";

const app = document.querySelector("#app");
if (!(app instanceof HTMLElement)) {
  throw new Error("#app missing");
}
mountBoard(app);
