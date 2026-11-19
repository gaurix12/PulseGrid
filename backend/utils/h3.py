from __future__ import annotations

from typing import Optional

import h3


H3_RESOLUTION = 9


def compute_h3_index(latitude: object, longitude: object) -> Optional[str]:
    try:
        latitude = float(latitude)
        longitude = float(longitude)
    except (TypeError, ValueError):
        return None

    if not (-90 <= latitude <= 90 and -180 <= longitude <= 180):
        return None

    try:
        return h3.latlng_to_cell(latitude, longitude, H3_RESOLUTION)
    except h3.H3BaseException:
        return None


def compute_h3_from_location(location: object) -> Optional[str]:
    if not location:
        return None
    parts = [part.strip() for part in str(location).replace(";", ",").split(",")]
    if len(parts) < 2:
        return None
    return compute_h3_index(parts[0], parts[1])


def h3_grid_distance(cell1: Optional[str], cell2: Optional[str]) -> Optional[int]:
    if not cell1 or not cell2:
        return None
    try:
        return h3.grid_distance(cell1, cell2)
    except (h3.H3BaseException, ValueError):
        return None


def get_nearby_cells(h3_index: Optional[str], k: int = 3) -> list[str]:
    if not h3_index or k < 0:
        return []
    try:
        return list(h3.grid_disk(h3_index, k))
    except (h3.H3BaseException, ValueError):
        return []
