"""Build the shared DEM-derived display coastline, heights and wave distances.

This entry point accepts --dataset and the options in build_coastline_field.py.
Both commands generate the same asset consumed by geometry and water materials.
"""
from build_coastline_field import main


if __name__ == '__main__':
    main()
