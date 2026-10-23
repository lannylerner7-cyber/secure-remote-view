import { SessionCore } from "./session-core";
import { Badge, Button } from "./ui";

export function NotFoundContent() {
  return (
    <section className="section overflow-hidden">
      <div className="container grid items-center gap-8 lg:grid-cols-2">
        <div>
          <Badge>404 · Session not found</Badge>
          <h1 className="display-lg mt-7">This route left the operating surface.</h1>
          <p className="body-lg mt-6 max-w-xl">
            The page may have moved or the address may be incomplete. Return to the platform or
            choose a clear next step.
          </p>
          <div className="mt-9 flex flex-wrap gap-3">
            <Button to="/" data-testid="link-404-home">
              Return home
            </Button>
            <Button to="/plans" variant="secondary">
              View plans
            </Button>
            <Button to="/contact" variant="ghost">
              Contact us
            </Button>
          </div>
        </div>
        <SessionCore compact />
      </div>
    </section>
  );
}
