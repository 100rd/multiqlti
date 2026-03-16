import { useState } from "react";
import { Copy, Eye, EyeOff, AlertTriangle } from "lucide-react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

interface WebhookDetailsProps {
  webhookUrl: string;
  /** Plaintext secret — only available immediately after creation */
  secret: string;
}

export function WebhookDetails({ webhookUrl, secret }: WebhookDetailsProps) {
  const [secretRevealed, setSecretRevealed] = useState(false);
  const [urlCopied, setUrlCopied] = useState(false);
  const [secretCopied, setSecretCopied] = useState(false);

  async function copyText(text: string, setFlag: (v: boolean) => void) {
    await navigator.clipboard.writeText(text);
    setFlag(true);
    setTimeout(() => setFlag(false), 2000);
  }

  const maskedSecret = `sk_${"•".repeat(16)}`;

  return (
    <div className="space-y-4">
      <Alert className="border-amber-500/50 bg-amber-500/5">
        <AlertTriangle className="h-4 w-4 text-amber-500" />
        <AlertDescription className="text-xs text-amber-700">
          This secret will not be shown again in full. Copy it now and store it securely.
        </AlertDescription>
      </Alert>

      {/* Endpoint URL */}
      <div className="space-y-1.5">
        <Label htmlFor="webhook-url" className="text-xs font-medium">
          Webhook Endpoint
        </Label>
        <div className="flex gap-2">
          <Input
            id="webhook-url"
            value={webhookUrl}
            readOnly
            className="font-mono text-xs h-8"
            aria-label="Webhook endpoint URL"
          />
          <Button
            variant="outline"
            size="sm"
            className="h-8 px-3 shrink-0"
            onClick={() => copyText(webhookUrl, setUrlCopied)}
            aria-label="Copy webhook URL"
          >
            <Copy className="h-3.5 w-3.5 mr-1" />
            {urlCopied ? "Copied!" : "Copy"}
          </Button>
        </div>
        <p className="text-[10px] text-muted-foreground">
          Configure your service to send a{" "}
          <span className="font-mono font-semibold">POST</span> request to this URL.
        </p>
      </div>

      {/* HMAC Secret */}
      <div className="space-y-1.5">
        <Label htmlFor="webhook-secret" className="text-xs font-medium">
          HMAC Secret
        </Label>
        <div className="flex gap-2">
          <Input
            id="webhook-secret"
            value={secretRevealed ? secret : maskedSecret}
            readOnly
            type={secretRevealed ? "text" : "password"}
            className="font-mono text-xs h-8"
            aria-label="HMAC secret"
          />
          <Button
            variant="outline"
            size="sm"
            className="h-8 w-8 p-0 shrink-0"
            onClick={() => setSecretRevealed((v) => !v)}
            aria-label={secretRevealed ? "Hide secret" : "Reveal secret"}
          >
            {secretRevealed ? (
              <EyeOff className="h-3.5 w-3.5" />
            ) : (
              <Eye className="h-3.5 w-3.5" />
            )}
          </Button>
          <Button
            variant="outline"
            size="sm"
            className="h-8 px-3 shrink-0"
            onClick={() => copyText(secret, setSecretCopied)}
            aria-label="Copy HMAC secret"
          >
            <Copy className="h-3.5 w-3.5 mr-1" />
            {secretCopied ? "Copied!" : "Copy"}
          </Button>
        </div>
        <p className="text-[10px] text-muted-foreground">
          Use this to verify the{" "}
          <span className="font-mono font-semibold">X-Hub-Signature-256</span> header
          on incoming requests.
        </p>
      </div>
    </div>
  );
}
