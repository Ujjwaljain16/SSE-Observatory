import { useState } from 'react'

/** Free-text search box state; matching is done by the filter engine. */
export const useEventSearch = () => {
    const [searchQuery, setSearchQuery] = useState('')
    return { searchQuery, setSearchQuery }
}
