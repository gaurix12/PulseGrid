/**
 * P3.1 – Generic pagination hook.
 * Usage:
 *   const { page, setPage, totalPages, pageItems } = usePagination(items, 20)
 */
import { useMemo, useState } from 'react'

/**
 * @param {Array}  items        - Full sorted/filtered array to paginate
 * @param {number} itemsPerPage - Page size (default 20)
 */
export function usePagination(items, itemsPerPage = 20) {
  const [page, setPage] = useState(1)

  const totalPages = Math.max(1, Math.ceil(items.length / itemsPerPage))

  // Clamp page if the data shrinks (e.g. after a filter is applied)
  const safePage = Math.min(page, totalPages)

  const pageItems = useMemo(() => {
    const start = (safePage - 1) * itemsPerPage
    return items.slice(start, start + itemsPerPage)
  }, [items, safePage, itemsPerPage])

  function goTo(n) {
    setPage(Math.max(1, Math.min(totalPages, n)))
  }

  return {
    page: safePage,
    setPage: goTo,
    totalPages,
    pageItems,
    hasPrev: safePage > 1,
    hasNext: safePage < totalPages,
    prev: () => goTo(safePage - 1),
    next: () => goTo(safePage + 1),
  }
}
