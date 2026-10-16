import { useParams } from "react-router-dom";
import { useResolve, useServerInfo } from "../api/queries";

/** repo, rev and path from the URL, the resolved changeset id, and whether the repo exists. */
export function useRepoRoute() {
  const params = useParams();
  const repo = params.repo ?? "";
  const rev = params.rev ?? "main";
  const path = (params["*"] ?? "").replace(/\/+$/, "");
  const info = useServerInfo();
  const resolved = useResolve(rev);
  const unknownRepo = !!info.data && info.data.repo !== repo;
  return { repo, rev, path, cs: resolved.data, resolved, info, unknownRepo };
}
