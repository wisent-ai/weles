// A value goes into a page's field whole or not at all. The longest value a
// field takes is the field's own `maxlength`, read from the page, never a
// number written here; a value longer than that is refused naming both
// lengths, so the operator shortens the text instead of the platform keeping
// a cut nobody chose.
export async function fitsField(locator, value, what) {
  const declared = await locator.getAttribute('maxlength');
  if (declared === null) return value;
  const max = Number(declared);
  if (value.length > max) {
    throw new Error(
      `${what} is ${value.length} characters and the page's field takes ${max}; shorten it in the character's profile`,
    );
  }
  return value;
}
