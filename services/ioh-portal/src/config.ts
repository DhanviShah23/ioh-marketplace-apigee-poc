export interface Config {
  port: number;
  githubToken: string;
  githubOwner: string;
  githubRepo: string;
  defaultBaseBranch: string;
  catalogSvcUrl: string;
  catalogSvcInvokerSa?: string;
}

export function loadConfig(): Config {
  const port = Number(process.env.PORT ?? "4103");
  const githubToken = process.env.GITHUB_TOKEN;
  const githubOwner = process.env.GITHUB_OWNER ?? "DhanviShah23";
  const githubRepo = process.env.GITHUB_REPO ?? "ioh-marketplace-apigee-poc";
  const defaultBaseBranch = process.env.GITHUB_BASE_BRANCH ?? "main";
  const catalogSvcUrl = process.env.CATALOG_SVC_URL ?? "http://localhost:4102";
  const catalogSvcInvokerSa = process.env.CATALOG_SVC_INVOKER_SA;

  if (!githubToken) {
    throw new Error("GITHUB_TOKEN is required");
  }

  return { port, githubToken, githubOwner, githubRepo, defaultBaseBranch, catalogSvcUrl, catalogSvcInvokerSa };
}
