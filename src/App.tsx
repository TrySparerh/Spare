import { Toaster } from "@/components/ui/sonner";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { BrowserRouter, Navigate, Routes, Route } from "react-router-dom";
import { WagmiProvider } from "wagmi";
import { ErrorBoundary } from "@/components/ErrorBoundary";
import { LanguageToggle } from "@/components/LanguageToggle";
import NotFound from "./pages/NotFound";
import PrivacyPolicy from "./pages/PrivacyPolicy";
import TermsConditions from "./pages/TermsConditions";
import Retro from "./pages/Retro";
import Docs from "./pages/Docs";
import Whitepaper from "./pages/Whitepaper";
import Roadmap from "./pages/Roadmap";
import DevTools from "./pages/DevTools";
import DataLayer from "./pages/DataLayer";
import Dispatch from "./pages/Dispatch";
import Mcp from "./pages/Mcp";
import Flywheel from "./pages/Flywheel";
import Universe from "./pages/Universe";
import Buyback from "./pages/Buyback";
import Proof from "./pages/Proof";
import { wagmiConfig } from "./lib/wagmi";

const queryClient = new QueryClient();

const App = () => (
  <ErrorBoundary>
    <WagmiProvider config={wagmiConfig}>
      <QueryClientProvider client={queryClient}>
        <Toaster />
        <BrowserRouter>
          {/* Floating EN ⇄ 中文 toggle — visible on every route. */}
          <LanguageToggle />
          <Routes>
            {/* The Spare app: BIOS → wallet login → desktop. */}
            <Route path="/" element={<Retro />} />
            <Route path="/retro" element={<Navigate to="/" replace />} />

            {/* How Spare works: guide, fees, limits, risks, contracts, FAQ. */}
            <Route path="/docs" element={<Docs />} />
            {/* Spare's design paper. */}
            <Route path="/whitepaper" element={<Whitepaper />} />
            {/* S1 live → S2 private round-ups → S3 boosts + $SPARE → S4 in-flow round-ups. */}
            <Route path="/roadmap" element={<Roadmap />} />
            {/* Contracts, ABIs, events, the keeper and a local mainnet fork. */}
            <Route path="/devtools" element={<DevTools />} />
            {/* Live receipts: Robinhood Chain, Chainlink feeds, pinned pools, deployments. */}
            <Route path="/datalayer" element={<DataLayer />} />
            {/* Live sweep log from the keeper and contract events. */}
            <Route path="/dispatch" element={<Dispatch />} />
            {/* The stocks Spare can buy, with live Chainlink prices. */}
            <Route path="/universe" element={<Universe />} />
            {/* Where Spare's fees go: FeeVault today, $SPARE buybacks in S3. */}
            <Route path="/buyback" element={<Buyback />} />
            {/* Payments → round-ups → stocks → fees → $SPARE (S3). */}
            <Route path="/flywheel" element={<Flywheel />} />
            {/* Spare MCP: read-only tools for AI agents. */}
            <Route path="/mcp" element={<Mcp />} />
            {/* What was built and how to verify it: contracts, roles, limits, status, audit. */}
            <Route path="/proof" element={<Proof />} />

            {/* Legal */}
            <Route path="/privacy" element={<PrivacyPolicy />} />
            <Route path="/terms" element={<TermsConditions />} />

            <Route path="*" element={<NotFound />} />
          </Routes>
        </BrowserRouter>
      </QueryClientProvider>
    </WagmiProvider>
  </ErrorBoundary>
);

export default App;
