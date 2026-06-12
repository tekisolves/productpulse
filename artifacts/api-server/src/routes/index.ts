import { Router, type IRouter } from "express";
import healthRouter from "./health";
import rewriteRouter from "./rewrite";
import suggestRouter from "./suggest";

const router: IRouter = Router();

router.use(healthRouter);
router.use(rewriteRouter);
router.use(suggestRouter);

export default router;
