import { handle } from "hono/vercel";
import { app } from "../router/handler.js";

export default handle(app);
