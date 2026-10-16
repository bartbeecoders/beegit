import { Route, Routes } from "react-router-dom";
import { Layout, RequireAuth } from "./components/Layout";
import { AccountPage, AuthCallbackPage, LoginPage } from "./pages/Auth";
import { BlamePage } from "./pages/Blame";
import { BlobPage, TreePage } from "./pages/Browse";
import { ComparePage } from "./pages/Compare";
import { ChangePage, LogPage } from "./pages/History";
import { RefLogPage, RefsPage } from "./pages/Refs";
import { NotFoundPage, RepoRedirect, ReposPage } from "./pages/Repos";

const auth = (el: React.ReactNode) => <RequireAuth>{el}</RequireAuth>;

export function App() {
  return (
    <Routes>
      <Route element={<Layout />}>
        <Route path="/login" element={<LoginPage />} />
        <Route path="/auth/callback" element={<AuthCallbackPage />} />
        <Route path="/" element={auth(<ReposPage />)} />
        <Route path="/account" element={auth(<AccountPage />)} />
        <Route path="/r/:repo" element={auth(<RepoRedirect />)} />
        <Route path="/r/:repo/tree/:rev/*" element={auth(<TreePage />)} />
        <Route path="/r/:repo/blob/:rev/*" element={auth(<BlobPage />)} />
        <Route path="/r/:repo/blame/:rev/*" element={auth(<BlamePage />)} />
        <Route path="/r/:repo/log/:rev/*" element={auth(<LogPage />)} />
        <Route path="/r/:repo/c/:id" element={auth(<ChangePage />)} />
        <Route path="/r/:repo/refs" element={auth(<RefsPage />)} />
        <Route path="/r/:repo/refs/:name" element={auth(<RefLogPage />)} />
        <Route path="/r/:repo/compare" element={auth(<ComparePage />)} />
        <Route path="/r/:repo/compare/:spec" element={auth(<ComparePage />)} />
        <Route path="*" element={<NotFoundPage />} />
      </Route>
    </Routes>
  );
}
