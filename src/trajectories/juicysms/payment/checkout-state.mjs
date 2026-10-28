// Where the Stripe checkout JuicySMS hands a top-up to stands after the pay
// click, read in the page in one pass (`pageCondition`), so no URL waiter
// and frame waiter race each other.

/**
 * Back on JuicySMS's success or failure page, a visible bank verification
 * frame (when `observeVerification`), an input Stripe marks invalid, or
 * false while none of those shows.
 */
export function checkoutState(observeVerification) {
  const address = new URL(location.href);
  const path = address.pathname.replace(/\/$/, '');
  if (
    address.origin === 'https://juicysms.com' &&
    (path === '/payments/success' || path === '/payments/failed')
  ) {
    return { kind: 'returned', path };
  }
  if (address.origin !== 'https://checkout.stripe.com') return false;
  // Shown, and at least partly inside the viewport.
  const visible = (element) => {
    if (
      !element.checkVisibility({
        opacityProperty: true,
        visibilityProperty: true,
      })
    )
      return false;
    const box = element.getBoundingClientRect();
    return (
      box.width > 0 &&
      box.height > 0 &&
      box.right > 0 &&
      box.bottom > 0 &&
      box.left < innerWidth &&
      box.top < innerHeight
    );
  };
  if (observeVerification) {
    const frame = [
      ...document.querySelectorAll(
        'iframe[src*="3d_secure"], iframe[name*="3ds" i], iframe[src^="https://hooks.stripe.com/"]',
      ),
    ].find(visible);
    if (frame) return { kind: 'verification' };
  }
  const invalid = [
    ...document.querySelectorAll('input[aria-invalid="true"]'),
  ].find(visible);
  if (invalid)
    return { kind: 'input_refused', field: invalid.name || invalid.id };
  return false;
}
